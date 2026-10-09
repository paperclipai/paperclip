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
  parseNativeSessionGoalControl,
} from "./heartbeat/scheduling.js";
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
  isHeartbeatRunRuntimeStatusActive,
  publishHeartbeatRunRuntimeProgress,
  decorateHeartbeatRunRuntimeStatus,
  createHeartbeatLifecycle,
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
  WorkspaceBusyDeferral,
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
  describeSessionResetReason,
  isCanonicalSessionIdForAdapter,
  requiresCanonicalSessionIds,
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
  buildPaperclipWakePayload,
  PAPERCLIP_WAKE_PAYLOAD_KEY,
  resolveRunScopedMentionedSkillKeys,
  resolveExecutionRunAdapterConfig,
  applyRunScopedMentionedSkillKeys,
  MANAGED_GITHUB_TOKEN_KEYS,
  configuredPaperclipApiBaseUrl,
  buildPaperclipRuntimeMcpServers,
  createAdapterRuntimeToolAccess,
  paperclipApiBaseUrl,
  createAdapterRuntimeMcpAccess,
  createManagedMcpRunConfig,
  revokeHeartbeatRunGatewayTokens,
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
  resolveNativeRecoveryExecutionWorkspaceBinding,
  resolveExecutionWorkspaceReuseRequestForIssue,
  buildExecutionWorkspaceConfigSnapshot,
  stripWorkspaceRuntimeFromExecutionRunConfig,
  buildEffectiveRunSessionConfigMetadata,
  readConfigFingerprintFromSessionParams,
  readConfiguredModelFromAdapterConfig,
  resolveTaskSessionConfigFreshness,
  stripPaperclipSessionMetadataFromSessionParams,
  resolveWorkspaceAfterLowTrustPreflight,
  WorkspaceValidationFailure,
  stripHostWorkspaceProvisionForLowTrustSandbox,
  assertGitWorktreeBaseWorkspaceReady,
  buildEffectiveRunWorkspaceConfigMetadata,
  resolveExecutionWorkspaceConfigFreshness,
  resolveExecutionWorkspaceReuseProvisioningPolicy,
  provisionExecutionWorkspaceForFreshnessDecision,
  mergeExecutionWorkspaceMetadataForPersistence,
  resolveExecutionWorkspaceBranchOwnership,
  reconcileReusedExecutionWorkspaceProjectWorkspaceId,
  recordWorkspaceConfigFreshnessOperation,
  prepareProjectRepositoryWorkspaces,
  resolveRuntimeSessionParamsForWorkspace,
  buildRunWorkspaceHints,
  buildReferencedProjectRunObservability,
  assertGitSensitiveAdapterWorkspaceValid,
  isWorkspaceValidationFailure,
  fingerprintFinalizeWorkspaceBranchValidation,
  attachPaperclipSessionMetadataToSessionParams,
  type EffectiveRunSessionConfigMetadata,
  createHeartbeatWorkspaceResolver,
} from "./heartbeat/workspaces.js";
export {
  WorkspaceValidationFailure,
  requiresPushCapabilityPreflight,
  applyPersistedExecutionWorkspaceConfig,
  mergeExecutionWorkspaceMetadataForPersistence,
  resolveExecutionWorkspaceBranchOwnership,
  stripWorkspaceRuntimeFromExecutionRunConfig,
  stripHostWorkspaceProvisionForLowTrustSandbox,
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
import {
  appendExcerpt,
  boundHeartbeatRunEventPayloadForStorage,
  compactRunLogChunk,
} from "./heartbeat/run-log.js";
export {
  boundHeartbeatRunEventPayloadForStorage,
  compactRunLogChunk,
} from "./heartbeat/run-log.js";
import { buildPaperclipTaskMarkdown } from "./heartbeat/task-markdown.js";
export { buildPaperclipTaskMarkdown } from "./heartbeat/task-markdown.js";

import { recordLegacyWorkspaceRestoreFailure } from "./legacy-execution-recovery.js";
import {
  configuredEnvironmentProjection,
} from "../vendor/paperclip-runner/index.js";
import { decisionModelService } from "./decision-models.js";
import { TASK_QUESTION_GUIDANCE } from "./issue-question-context.js";
import { createAgentIdentityRedactor } from "./agent-identity-redaction.js";
import { agentIdentityService, supportsManagedAgentIdentity } from "./agent-identity.js";
import { buildAgentIdentityEnv } from "@paperclipai/adapter-utils/server-utils";

import { prepareConnectionInstructionDelivery } from "./connection-instructions.js";
import { resolveAssignedConnectionInstructionsForRun } from "./native-runtime/assigned-mcp-tools.js";
import { externalObjectService } from "./external-objects.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

import {
  startupCancellationFence,
} from "./native-runtime/native-cancellation-request.js";
import {
  prepareChatCompletionTurn,
  chatCompletionInstruction,
} from "./chat-completion-delivery.js";
import { AgentDirectoryReuseInvalidatedError, isAgentDirectoryCopy } from "./agent-directory-working-copies.js";

import type { PaperclipTurnContext } from "@paperclipai/adapter-utils/server-utils";
import { restoreNativeWorkspaceBestEffort } from "./native-runtime/native-workspace-best-effort.js";

import {
  withNativeWorkspaceFinalizationOwnership,
  NativeWorkspaceFinalizationBusyError,
  NativeWorkspaceFinalizationOwnershipLostError,
  type NativeWorkspaceFinalizationOwnership,
} from "./native-runtime/native-workspace-finalization-ownership.js";

import { reserveRunBudget } from "./budget-reservations.js";
import { accountRunCost, createCostAccountingReconciler } from "./run-cost-accounting.js";
import { createRunUsageRecorder } from "./usage-receipts.js";
import { applyWorkspaceRestoreFailure } from "@paperclipai/adapter-utils/workspace-restore-result";
import {
  hasWorkspaceRestoreFailure,
} from "@paperclipai/shared";

import { toolActionDeliveryService } from "./tool-action-delivery.js";
import { githubBotConnectionIdsForRun } from "./chat-github-tools.js";

import {
  isConversation,
  prepareConversationTurn,
  settleConversationTurn,
} from "./agent-conversations.js";
import { withAdapterExecutionPhase } from "@paperclipai/adapter-utils/execution-phase";
import { getConversationConfirmationContext } from "./conversation-confirmation-context.js";
import {
  recordNativeLocalProcessStop,
} from "./native-local-process-stop.js";

import {
  legacyControllerBootId,
  watchLegacyControllerLease,
} from "./legacy-controller-lease.js";

import {
  remoteExecutionHasStopped,
} from "./remote-execution-termination.js";
import { applyConnectorSkills, prepareConnectorSkillDelivery, resolveConnectorAssignments } from "./connector-runtime.js";

import { connectionIntentService } from "./connection-intents.js";
import {
  prepareManagedAiRuntime,
  assertManagedAiProjectAuth,
  stripAiAuthBindings,
  isAiConnectionBusy,
  AI_AUTH_ENV_KEYS,
} from "./ai-connection-runtime.js";
import { aiConnectionBindingSchema, aiRuntimeConnectionBindingSchema, type AiConnectionRouterSelection } from "@paperclipai/shared";
import { aiConnectionRouterService, AiConnectionPoolExhausted, applyAiConnectionRouterTaskSettings } from "./ai-connection-router.js";
import { aiConnectionSessionCompatibilityInputs, managedAiSessionIdentityCompatible } from "./ai-connection-session.js";
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
  registerAdapterExecutionControl,
} from "./adapter-execution-control.js";
import { executionFailureRetryCount } from "./execution-recovery-attempt.js";
import { buildHeartbeatRunStatusLiveEventPayload } from "./heartbeat-run-status-payload.js";
export { buildHeartbeatRunStatusLiveEventPayload } from "./heartbeat-run-status-payload.js";
import { buildExecutionContinuation, StaleExecutionContinuationError } from "./execution-continuation.js";
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
import { agentInstructionWorkingCopyService, collectStoppedInstructionCopyWithRetries, instructionWorkingCopyGuidance } from "./agent-instruction-working-copies.js";
import {
  resolveManagedOpenAiBilling,
} from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  createHash,
} from "node:crypto";
import {
  and,
  asc,
  desc,
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
  type ExecutionWorkspace,
} from "@paperclipai/shared";
import {
  agents,
  agentConfigRevisions,
  agentWakeupRequests,
  chatActions,
  heartbeatRuns,
  environmentLeases,
  issueComments,
  issues,
  nativeRunFinalizations,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import { conflict, HttpError, notFound } from "../errors.js";
import {
  getStartupTraceContext,
  getStartupTracer,
} from "../instrumentation.js";
import { createHostDuplexObservabilityRecorder } from "./duplex-observability-recorder.js";
import { incrementToolRuntimeMetricCounter } from "./tool-runtime-metrics.js";
import { logger } from "../middleware/logger.js";
import {
  createGitRemoteAuthProvider,
  resolveManagedGitHubIdentitySelection,
  scrubGitCredentialText,
} from "./git-credentials.js";
// Re-exported because heartbeat's workspace surface exposed the scrubber before the
// git-credentials module became its canonical home; existing importers keep working.
export { scrubGitCredentialText };
import { publishLiveEvent } from "./live-events.js";

import {
  queuedCommentIdsFromRunContext,
} from "./issue-queued-comment-queue.js";

import { getTaskPlanContext } from "./task-plan-context.js";

import {
  buildNativeProviderEnvironment,
  claimWarmNativeInstructionCopy,
  nativeSessionWorkspaceScope,
  reserveWarmNativeInstructionDirectory,
  dispatchNativeSessionResumptions,
  executePaperclipNativeSession,
  finalizeNativeRun,
  isRunnerIngressAuthorized,
  materializeLegacyQuestionResponseWakeProjection,
  NativeCancellationPendingRecoveryError,
  NativeControllerDetachedForRestartError,
  prepareNativeWorkspaceSync,
  readNativeWorkspaceSyncReference,
  recordNativeFinalizationFailure,
  type NativeRestartRecoveryClaim,
  resolveHeartbeatNativeRuntimeMode,
} from "./native-runtime/index.js";

import {
  buildNativeHeartbeatPreparationSpans,
  buildNativeWakeIngressSpan,
  recordFailedSkillPreparation,
  type NativeRunHistoricalSpan,
} from "./native-runtime/native-run-trace.js";
import {
  parseNativeExecutionInput,
  type NativeExecutionInput,
  type NativeSessionBackend,
} from "../vendor/paperclip-runner/index.js";
import { createNativeSessionHandoffLoader } from "./native-runtime/native-session-handoff.js";

import { getRunLogStore, type RunLogHandle } from "./run-log-store.js";
import {
  providerTraceStore,
  PROVIDER_TRACE_MAX_BYTES,
} from "./provider-trace-store.js";
import { getServerAdapter, runningProcesses } from "../adapters/index.js";
import type {
  AdapterExecutionResult,
  AdapterInvocationMeta,
  AdapterRuntimeEvent,
} from "../adapters/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import {
  parseObject,
  asNumber,
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
  findNativeChatWorkspaceScope,
  materializeNativeChatTaskRoot,
  nativeChatWorkspaceCwd,
  nativeChatWorkspaceMatches,
} from "./native-runtime/native-chat-workspace.js";
import { materializeIsolatedTaskDirectory, shouldUseIsolatedTaskDirectory } from "./isolated-task-directory.js";
import { trackAgentFirstHeartbeat } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import {
  emitAgentTaskRun,
  emitAgentTaskRunById,
} from "./agent-task-run-telemetry.js";
import { readAiConnectionConfigurationFailure } from "./ai-connection-configuration-failure.js";
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
  buildWorkspaceReadyComment,
  buildWorkspaceReadyMetadata,
  buildWorkspaceReadyPresentation,
  cleanupExecutionWorkspaceArtifacts,
  ensureGitWorktreeBranchCoherent,
  ensurePersistedExecutionWorkspaceAvailable,
  ensureRuntimeServicesForRun,
  formatManagedGitWorktreeBranchInspection,
  inspectManagedGitWorktreeBranch,
  persistAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
  type ExecutionWorkspaceInput,
  type RealizedExecutionWorkspace,
  type RuntimeServiceRef,
} from "./workspace-runtime.js";

import {
  readManagedWorktreeInstanceOwnership,
  WORKTREE_INSTANCE_ROOT_METADATA_KEY,
} from "./workspace-instance-cleanup.js";
import { issueService } from "./issues.js";
import {
  blockRunnerGoalRecovery,
  failRunnerGoalAction,
  isRunnerGoalActionCompleted,
  settleLiveRunnerGoalBeforeInterrupt,
} from "./runner-goals.js";

import {
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import {
  issueTreeControlService,
} from "./issue-tree-control.js";
import {
  continuationSummaryParksExecutor,
  getIssueContinuationSummaryDocument,
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
  isRuntimeOwnedGitBranch,
} from "./execution-workspace-branch-ownership.js";
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
  gateProjectExecutionWorkspacePolicy,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveEffectiveWorkspaceStrategyType,
  resolveExecutionWorkspaceEnvironmentId,
  resolveExecutionWorkspaceMode,
  resolveSharedWorkspaceConcurrency,
  selectEnvironmentExecutionWorkspaceSettings,
} from "./execution-workspace-policy.js";
import {
  instanceSettingsService,
  resolveWorktreeRunExecutionActivation,
} from "./instance-settings.js";
import {
  evaluateExecutionAllowlist,
  isExecutionForcedToKubernetes,
} from "./execution-allowlist.js";

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
  AI_CONNECTION_BUSY_RETRY_REASON,
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

import {
  redactQuarantinedBodyForHigherTrust,
  sanitizeQuarantinedCommentForHigherTrust,
} from "./source-trust.js";
import {
  redactCurrentUserText,
} from "../log-redaction.js";

import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";

import {
  readPaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";

import { environmentService } from "./environments.js";
import { parseExecutionPolicyBootstrapEnv } from "./execution-policy-bootstrap.js";

import {
  environmentRuntimeService,
  type ProviderResourceDisposition,
} from "./environment-runtime.js";
import { skillVersionSelectionMap } from "./runtime-skill-selections.js";
import { environmentRunOrchestrator } from "./environment-run-orchestrator.js";

import {
  clearHeartbeatRunRuntimeStatus,
  sweepExpiredHeartbeatRunRuntimeStatuses,
  touchHeartbeatRunRuntimeStatus,
} from "./heartbeat-run-runtime-status.js";

import {
  assertLowTrustRuntimeServicesAllowed,
} from "./low-trust-runtime-containment.js";

import { resolveAndRetainRunTrustPreset } from "./run-trust-preset.js";

import type { PluginWorkerManager } from "./plugin-worker-manager.js";

import { computeTaskDrain, applyTaskDrain, startTaskDrain, stopTaskDrain, readTaskDrain } from "./task-admission.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;

const ACCEPTED_PLAN_CONVERSION_SKILL_KEY =
  "paperclipai/paperclip/paperclip-converting-plans-to-tasks";

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
export const ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS = 60 * 1000;
export const ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS = 5 * 1000;

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

interface ParsedIssueAssigneeAdapterOverrides {
  adapterConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseIssueAssigneeAdapterOverrides(
  raw: unknown,
): ParsedIssueAssigneeAdapterOverrides | null {
  const parsed = parseObject(raw);
  const parsedAdapterConfig = parseObject(parsed.adapterConfig);
  const adapterConfig =
    Object.keys(parsedAdapterConfig).length > 0 ? parsedAdapterConfig : null;
  const useProjectWorkspace =
    typeof parsed.useProjectWorkspace === "boolean"
      ? parsed.useProjectWorkspace
      : null;
  if (!adapterConfig && useProjectWorkspace === null) return null;
  return {
    adapterConfig,
    useProjectWorkspace,
  };
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

class NativeSessionResumeScheduledError extends Error {
  constructor(readonly original: unknown) {
    super("Native session recovery has been scheduled for the same run.");
    this.name = "NativeSessionResumeScheduledError";
  }
}

class NativeWorkspaceFinalizeScheduledError extends Error {
  constructor(
    readonly original: unknown,
    readonly terminalFailure: boolean,
    readonly reasonCode:
      "workspace_sync_out_failed" | "workspace_sync_out_unrecoverable",
  ) {
    super("Native workspace finalization recovery has been scheduled.");
    this.name = "NativeWorkspaceFinalizeScheduledError";
  }
}

type WorkspaceReadyCommentWriter = {
  addComment: (
    issueId: string,
    body: string,
    actor: { agentId?: string; userId?: string; runId?: string | null },
    options?: {
      presentation?: ReturnType<typeof buildWorkspaceReadyPresentation>;
      metadata?: ReturnType<typeof buildWorkspaceReadyMetadata>;
    },
  ) => Promise<unknown>;
};

export function postWorkspaceReadyComment(input: {
  issuesSvc: WorkspaceReadyCommentWriter;
  issueId: string;
  agentId: string;
  runId: string;
  workspace: RealizedExecutionWorkspace;
  runtimeServices: RuntimeServiceRef[];
}) {
  const workspaceReadyInput = {
    workspace: input.workspace,
    runtimeServices: input.runtimeServices,
  };
  return input.issuesSvc.addComment(
    input.issueId,
    buildWorkspaceReadyComment(workspaceReadyInput),
    { agentId: input.agentId, runId: input.runId },
    {
      presentation: buildWorkspaceReadyPresentation(workspaceReadyInput),
      metadata: buildWorkspaceReadyMetadata(workspaceReadyInput),
    },
  );
}

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
  const {
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
    listRuns,
    getRuntimeStateWithSessions,
    listTaskSessions,
    resetRuntimeSession,
    listEvents,
    getRetryExhaustedReason,
    getRunIssueSummary,
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
  const resolveWorktreeRunExecutionOverride = async () => {
    if (!inWorktreeRuntime) return { allowed: false, cutoff: null };
    const now = Date.now();
    if (
      now - cachedWorktreeRunExecutionOverride.at <
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
    } catch {
      // Keep the prior (default-false) value so a settings read failure fails
      // closed to the safe suppressed state.
    }
    return cachedWorktreeRunExecutionOverride;
  };
  const getSchedulingSuppression = async () => {
    const override = await resolveWorktreeRunExecutionOverride();
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
  const executionWorkspacesSvc = executionWorkspaceService(db);
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
    finalizeAiConnectionBusyDeferral,
    finalizeWorkspaceBusyDeferral,
    promoteDueScheduledRetries,
    retryScheduledRetryNow,
    scheduleBoundedRetry,
  } = createHeartbeatRetries(db, {
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
  } = createHeartbeatRecovery(db, {
    enterShutdown: () => { shutdownInProgress = true; },
    scheduleBoundedRetryForRun,
    appendRunEvent,
    environmentRuntime,
    scheduleNativeSessionResumeDispatch,
    getRun,
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
    countRunningRunsForAgent,
    releaseRunClaimedJustBeforeSuppression,
    claimQueuedRun,
    withChatControlRecoveryGate,
    trackWakeup,
    resumeQueuedRuns,
    parseHeartbeatPolicy,
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

  const runLifecycle = createHeartbeatLifecycle(db, {
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

  function truncateAgentErrorReason(
    reason: string | null | undefined,
  ): string | null {
    if (!reason) return null;
    const trimmed = reason.trim();
    if (!trimmed) return null;
    return trimmed.length > 500 ? `${trimmed.slice(0, 499)}…` : trimmed;
  }

  async function finalizeAgentStatus(
    agentId: string,
    outcome: "succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out",
    failureReason?: string | null,
    options?: { keepIdleOnFailure?: boolean; wasFirstHeartbeat?: boolean },
  ) {
    const existing = await getAgent(agentId);
    if (!existing) return;

    if (existing.status === "paused" || existing.status === "terminated") {
      return;
    }

    const isFirstHeartbeat =
      options?.wasFirstHeartbeat ?? !existing.lastHeartbeatAt;

    const runningCount = await countRunningRunsForAgent(agentId);
    const nextStatus =
      runningCount > 0
        ? "running"
        : outcome === "succeeded" ||
            outcome === "interrupted" ||
            outcome === "cancelled" ||
            (outcome === "failed" && options?.keepIdleOnFailure)
          ? "idle"
          : "error";

    const updated = await db
      .update(agents)
      .set({
        status: nextStatus,
        // Persist a human-readable reason on the agent record when it enters
        // error so operators see it on the agent page without digging into run
        // events; clear it whenever the agent leaves error.
        errorReason:
          nextStatus === "error"
            ? truncateAgentErrorReason(failureReason)
            : null,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, agentId), eq(agents.lifecycleState, "ready")))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (isFirstHeartbeat && updated) {
      const tc = getTelemetryClient();
      if (tc)
        trackAgentFirstHeartbeat(tc, {
          agentRole: updated.role,
          agentId: updated.id,
        });
    }

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "agent.status",
        payload: {
          agentId: updated.id,
          status: updated.status,
          lastHeartbeatAt: updated.lastHeartbeatAt
            ? new Date(updated.lastHeartbeatAt).toISOString()
            : null,
          outcome,
        },
      });
    }
  }

  async function reconcileStrandedAssignedIssues() {
    return recovery.reconcileStrandedAssignedIssues({
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
    } = {},
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

    const instructionCleanupRun = run;
    let instructionCleanupDeferred = false;
    const releaseInstructionCopy = async () => {
      // Cleanup is retried from the durable working-copy receipt by the
      // recovery sweep. It must not replace the provider result (or prevent
      // lease release), and a timeout must not be repeated in outer teardown.
      if (instructionCleanupDeferred) return;
      try {
        await instructionCopies.release(instructionCleanupRun.companyId, instructionCleanupRun.id);
      } catch (err) {
        instructionCleanupDeferred = true;
        logger.warn({ err, runId: instructionCleanupRun.id }, "Agent file cleanup deferred; run outcome preserved");
        await appendRunEvent(instructionCleanupRun, {
          eventType: "instruction_cleanup",
          stream: "system",
          level: "warn",
          message: "Agent file cleanup was deferred. The run outcome and file-save receipt are unchanged.",
          payload: { state: "deferred" },
        }).catch((eventError) => {
          logger.warn({ err: eventError, runId: instructionCleanupRun.id }, "Failed to record deferred agent file cleanup");
        });
      }
    };

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
    let releaseWarmInstructionPreparation: (() => Promise<void>) | null = null;
    let nativeInstructionReservation: Awaited<ReturnType<typeof reserveWarmNativeInstructionDirectory>> = null;
    let nativeDispatchStarted = false;
    let nativeWorkspaceFinalizeScheduled = false;
    let nativeWorkspaceSync: Awaited<
      ReturnType<typeof prepareNativeWorkspaceSync>
    > = null;
    let requiredWorkspaceRestoreEvidence: Record<string, unknown> | null = null;
    let providerResourceDispositionForRun:
      ProviderResourceDisposition | undefined;
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
            ["todo", "backlog", "blocked"],
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
      const parsedIssueExecutionWorkspaceSettings =
        parseIssueExecutionWorkspaceSettings(
          issueContext?.executionWorkspaceSettings,
        );
      const issueExecutionWorkspaceSettings = isolatedWorkspacesEnabled
        ? parsedIssueExecutionWorkspaceSettings
        : null;
      const environmentExecutionWorkspaceSettings =
        selectEnvironmentExecutionWorkspaceSettings(
          parsedIssueExecutionWorkspaceSettings,
          isolatedWorkspacesEnabled,
        );
      const contextProjectId = readNonEmptyString(context.projectId);
      const executionProjectId = issueContext?.projectId ?? contextProjectId;
      const projectContext = executionProjectId
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
                  )),
              ).mapWith(Boolean),
              env: projects.env,
              updatedAt: projects.updatedAt,
            })
            .from(projects)
            .where(
              and(
                eq(projects.id, executionProjectId),
                eq(projects.companyId, agent.companyId),
              ),
            )
            .then((rows) => rows[0] ?? null)
        : null;
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
          run.retryOfRunId || context.retryOfRunId
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
      const parsedProjectExecutionWorkspacePolicy =
        parseProjectExecutionWorkspacePolicy(
          projectContext?.executionWorkspacePolicy,
        );
      const projectExecutionWorkspacePolicy =
        applyDefaultIsolatedExecutionWorkspacePolicy({
          projectPolicy: gateProjectExecutionWorkspacePolicy(
            parsedProjectExecutionWorkspacePolicy,
            isolatedWorkspacesEnabled,
          ),
          defaultIsolatedWorkspacesEnabled,
          // Projects without workspace configuration get a plain managed
          // directory. The operator default cannot turn it into a worktree.
          hasProjectWorkspace: projectContext?.hasWorkspace ?? false,
        });
      const retainedTrust = await resolveAndRetainRunTrustPreset(db, {
        companyId: agent.companyId,
        agentId: agent.id,
        runId: run.id,
        agent: {
          companyId: agent.companyId,
          permissions: agent.permissions,
        },
        project: projectContext
          ? {
              companyId: agent.companyId,
              // Workspace feature gates must not erase authorization policy.
              executionWorkspacePolicy: projectContext.executionWorkspacePolicy,
            }
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
      const routerHasPersistedInput = Object.keys(parseObject(parseObject(run.runnerProfileJson).nativeExecutionInput)).length > 0;
      const persistedRouterPoolId = routerHasPersistedInput ? readNonEmptyString(parseObject(context.aiRouterSelection).poolId) : null;
      const requestedAiBinding = persistedRouterPoolId ? { mode: "router" as const, connectionId: persistedRouterPoolId } : agent.runtimeConfig?.aiConnection ? aiRuntimeConnectionBindingSchema.parse(agent.runtimeConfig.aiConnection) : undefined;
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
        sessionCodec.deserialize(taskSession?.sessionParamsJson ?? null),
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
      const requestedExecutionWorkspaceMode =
        trustPreset.kind === "low_trust_review" &&
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
            executionWorkspaceId: issueContext.executionWorkspaceId,
            executionWorkspacePreference:
              issueContext.executionWorkspacePreference,
          }
        : null;
      const storedLedgerScope = parseObject(parseObject(run.usageJson).ledgerScope);
      const runLedgerScope = Object.keys(storedLedgerScope).length > 0
        ? storedLedgerScope
        : await resolveLedgerScopeForRun(db, agent.companyId, run);
      await db.update(heartbeatRuns).set({
        usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || ${JSON.stringify({ ledgerScope: runLedgerScope })}::jsonb`,
      }).where(eq(heartbeatRuns.id, run.id));
      const continuationSummary = issueRef && !isConversation(issueContext)
        ? await getIssueContinuationSummaryDocument(db, issueRef.id)
        : null;
      const exposeLowTrustRaw = trustPreset.kind === "low_trust_review";
      const safeContinuationSummary =
        continuationSummary && !exposeLowTrustRaw
          ? redactQuarantinedBodyForHigherTrust(continuationSummary)
          : continuationSummary;
      const safeWakeCommentContext =
        wakeCommentContext && !exposeLowTrustRaw
          ? sanitizeQuarantinedCommentForHigherTrust(wakeCommentContext)
          : wakeCommentContext;
      const issueAncestors = issueRef
        ? await issuesSvc.getAncestors(issueRef.id)
        : [];
      if (continuationSummary) {
        context.paperclipContinuationSummary = {
          key: safeContinuationSummary!.key,
          title: safeContinuationSummary!.title,
          body: safeContinuationSummary!.body,
          sourceTrust: safeContinuationSummary!.sourceTrust ?? null,
          updatedAt: safeContinuationSummary!.updatedAt.toISOString(),
        };
      } else {
        delete context.paperclipContinuationSummary;
      }
      const pinnedSkillTestContext =
        issueRef?.workMode === "skill_test"
          ? await getPinnedSkillTestContext(agent.companyId, issueRef.id)
          : null;
      if (pinnedSkillTestContext) {
        context.paperclipSkillTest = {
          ...pinnedSkillTestContext,
          directive:
            "Use this pinned file inventory as the exact skill revision under test, regardless of synced runtime skills.",
        };
      } else {
        delete context.paperclipSkillTest;
      }
      const executionContinuation =
        issueRef && !isConversation(issueContext) && issueContext?.assigneeAgentId === agent.id
          ? await buildExecutionContinuation({
              db,
              companyId: agent.companyId,
              issueId: issueRef.id,
              agentId: agent.id,
              runId: run.id,
              context,
              previousContextRunId: taskSession?.lastRunId,
              summary: safeContinuationSummary?.body ?? null,
              exposeLowTrustRaw,
            })
          : null;
      context.executionContinuation = executionContinuation;
      const paperclipWakePayload = await buildPaperclipWakePayload({
        db,
        companyId: agent.companyId,
        agentId: agent.id,
        runId: run.id,
        contextSnapshot: context,
        continuationSummary,
        issueSummary: issueRef
          ? {
              id: issueRef.id,
              identifier: issueRef.identifier,
              title: issueRef.title,
              description: issueContext?.description ?? null,
              status: issueRef.status,
              priority: issueRef.priority,
              workMode: issueRef.workMode,
              projectId: issueRef.projectId,
              executionPolicy: issueContext?.executionPolicy ?? null,
            }
          : null,
        exposeLowTrustRaw,
        simplifiedEnglishInteractions:
          experimentalInstanceSettings.enableSimplifiedEnglishInteractions ===
          true,
      });
      if (paperclipWakePayload) {
        context[PAPERCLIP_WAKE_PAYLOAD_KEY] = paperclipWakePayload;
      } else {
        delete context[PAPERCLIP_WAKE_PAYLOAD_KEY];
      }
      const safeWakeComments = (paperclipWakePayload?.comments ?? []).flatMap(
        (comment) =>
          typeof comment.id === "string" && typeof comment.body === "string"
            ? [
                {
                  id: comment.id,
                  body: comment.body,
                  attachments: Array.isArray(comment.attachments)
                    ? comment.attachments.flatMap((attachment) => {
                        const descriptor = parseObject(attachment);
                        const id = readNonEmptyString(descriptor.id);
                        const filename = readNonEmptyString(
                          descriptor.filename,
                        );
                        const contentType = readNonEmptyString(
                          descriptor.contentType,
                        );
                        const contentPath = readNonEmptyString(
                          descriptor.contentPath,
                        );
                        const byteSize = descriptor.byteSize;
                        return id &&
                          filename &&
                          contentType &&
                          contentPath &&
                          typeof byteSize === "number"
                          ? [
                              {
                                id,
                                filename,
                                contentType,
                                byteSize,
                                contentPath,
                              },
                            ]
                          : [];
                      })
                    : [],
                },
              ]
            : [],
      );
      // Always replace caller-supplied context with the immutable, company-scoped
      // conversation snapshot. It belongs only to the endpoint's assigned agent.
      context.paperclipTaskCommunicationGuidance =
        issueContext?.chatAssignedAgentId === agent.id
          ? issueContext.chatCommunicationGuidance
          : null;
      const taskMarkdownInput = {
        conversationConfirmations: issueRef && isConversation(issueContext)
          ? await getConversationConfirmationContext({ db, companyId: agent.companyId, issueId: issueRef.id, agentId: agent.id })
          : null,
        issue: issueRef
          ? {
              id: issueRef.id,
              identifier: issueRef.identifier,
              title: issueRef.title,
              titleNeedsGeneration: issueContext?.titleNeedsGeneration,
              workMode: issueRef.workMode,
              conversationAgentId: issueContext?.conversationAgentId,
              description: issueRef.description,
            }
          : null,
        ancestors: issueAncestors,
        wakeComment: safeWakeCommentContext,
        wakeComments: safeWakeComments,
        attachmentOmissions: paperclipWakePayload?.attachmentOmissions,
        externalChatProvider: paperclipWakePayload?.externalChatProvider,
        slackCommand: issueContext?.chatAssignedAgentId === agent.id
          ? issueContext.chatSlackCommand
          : null,
        nativeRunner: agent.adapterType === "paperclip_runner",
        interaction: {
          kind: readNonEmptyString(context.interactionKind),
          status: readNonEmptyString(context.interactionStatus),
        },
        planReview: paperclipWakePayload?.planReviewContext?.interaction
          ? {
              status: paperclipWakePayload.planReviewContext.interaction.status,
              reason: paperclipWakePayload.planReviewContext.interaction.result?.reason,
            }
          : null,
        acceptedPlanContinuation:
          readNonEmptyString(context.workspaceRefreshReason) ===
            "accepted_plan_confirmation" &&
          Object.keys(parseObject(context.acceptedPlanWakeRouting)).length ===
            0,
        acceptedPlan: (() => {
          const accepted = parseObject(
            parseObject(context.planReviewInteraction).acceptedTargetRevision,
          );
          const revisionId = readNonEmptyString(accepted.revisionId);
          if (!revisionId) return null;
          return {
            documentId: readNonEmptyString(accepted.documentId),
            revisionId,
            revisionNumber:
              typeof accepted.revisionNumber === "number"
                ? accepted.revisionNumber
                : null,
          };
        })(),
      };
      const taskPlan = issueRef && !isConversation(issueContext)
        ? await getTaskPlanContext({
            db,
            companyId: agent.companyId,
            issueId: issueRef.id,
            approvedRevisionId: taskMarkdownInput.acceptedPlan?.revisionId,
            exposeLowTrustRaw,
          })
        : null;
      let taskMarkdown = buildPaperclipTaskMarkdown({ ...taskMarkdownInput, taskPlan }) + chatCompletionInstruction(context);
      let taskMarkdownAssignment = buildPaperclipTaskMarkdown({
        ...taskMarkdownInput,
        taskPlan,
        includeWakeComments: false,
      }) + chatCompletionInstruction(context);
      const taskMarkdownCompact = buildPaperclipTaskMarkdown({
        ...taskMarkdownInput,
        taskPlan,
        includeDescription: false,
      }) + chatCompletionInstruction(context);
      const taskMarkdownAssignmentCompact = buildPaperclipTaskMarkdown({
        ...taskMarkdownInput,
        taskPlan,
        includeDescription: false,
        includeWakeComments: false,
      }) + chatCompletionInstruction(context);
      if (issueRef) {
        context.paperclipIssue = {
          id: issueRef.id,
          identifier: issueRef.identifier,
          title: issueRef.title,
          description: isConversation(issueContext) ? null : issueRef.description,
          workMode: issueRef.workMode,
        };
      } else {
        delete context.paperclipIssue;
      }
      if (wakeCommentContext) {
        context.paperclipWakeComment = safeWakeCommentContext;
      } else {
        delete context.paperclipWakeComment;
      }
      if (taskMarkdown) {
        context.paperclipTaskMarkdown = taskMarkdown;
      } else {
        delete context.paperclipTaskMarkdown;
      }
      if (taskMarkdownAssignment) {
        context.paperclipTaskMarkdownAssignment = taskMarkdownAssignment;
      } else {
        delete context.paperclipTaskMarkdownAssignment;
      }
      if (taskMarkdownCompact && taskMarkdownCompact !== taskMarkdown) {
        context.paperclipTaskMarkdownCompact = taskMarkdownCompact;
      } else {
        delete context.paperclipTaskMarkdownCompact;
      }
      if (taskMarkdownAssignmentCompact && taskMarkdownAssignmentCompact !== taskMarkdownAssignment) {
        context.paperclipTaskMarkdownAssignmentCompact = taskMarkdownAssignmentCompact;
      } else {
        delete context.paperclipTaskMarkdownAssignmentCompact;
      }
      if (issueRef) {
        const redactedWakeContext = await createRunSecretRedactionRegistry(
          db,
        ).redactForIssue(agent.companyId, issueRef.id, {
          paperclipIssue: context.paperclipIssue,
          paperclipWakeComment: context.paperclipWakeComment,
          paperclipTaskCommunicationGuidance: context.paperclipTaskCommunicationGuidance,
          paperclipTaskMarkdown: context.paperclipTaskMarkdown,
          paperclipTaskMarkdownCompact: context.paperclipTaskMarkdownCompact,
          paperclipTaskMarkdownAssignment: context.paperclipTaskMarkdownAssignment,
          paperclipTaskMarkdownAssignmentCompact: context.paperclipTaskMarkdownAssignmentCompact,
        });
        context.paperclipIssue = redactedWakeContext.paperclipIssue;
        context.paperclipTaskCommunicationGuidance = redactedWakeContext.paperclipTaskCommunicationGuidance;
        if (redactedWakeContext.paperclipWakeComment) {
          context.paperclipWakeComment =
            redactedWakeContext.paperclipWakeComment;
        }
        if (redactedWakeContext.paperclipTaskMarkdown) {
          context.paperclipTaskMarkdown =
            redactedWakeContext.paperclipTaskMarkdown;
        }
        if (redactedWakeContext.paperclipTaskMarkdownCompact) {
          context.paperclipTaskMarkdownCompact =
            redactedWakeContext.paperclipTaskMarkdownCompact;
        }
        if (redactedWakeContext.paperclipTaskMarkdownAssignment) {
          context.paperclipTaskMarkdownAssignment =
            redactedWakeContext.paperclipTaskMarkdownAssignment;
        }
        if (redactedWakeContext.paperclipTaskMarkdownAssignmentCompact) {
          context.paperclipTaskMarkdownAssignmentCompact =
            redactedWakeContext.paperclipTaskMarkdownAssignmentCompact;
        }
      }
      if (issueRef) {
        const digest = (value: string | null | undefined) =>
          value?.trim()
            ? createHash("sha256")
                .update(value.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""))
                .digest("hex")
            : null;
        const redactedIssue = parseObject(context.paperclipIssue);
        context.paperclipTurnContext = {
          version: 1,
          assignment: {
            owner: "task_markdown",
            description: {
              id: issueRef.id,
              revision: digest(readNonEmptyString(redactedIssue.description)),
            },
          },
          events: {
            owner: "wake_prompt",
            comments: safeWakeComments.map((comment) => ({
              id: comment.id,
              revision: digest(comment.body),
            })),
          },
        } satisfies PaperclipTurnContext;
      } else {
        delete context.paperclipTurnContext;
      }
      // A native run's execution input is immutable once persisted. Recovery must therefore
      // restore the workspace bound to that input rather than consulting the issue's current
      // workspace pointer: a newer run may already have moved or cleared the issue binding while
      // this older provider session is still recoverable.
      const persistedRunnerProfile = parseObject(run.runnerProfileJson);
      const persistedNativeExecutionInput =
        run.runtimeMode === "native" &&
        persistedRunnerProfile.nativeExecutionInput !== undefined
          ? parseNativeExecutionInput(
              persistedRunnerProfile.nativeExecutionInput,
            )
          : null;
      const isDotRun = persistedNativeExecutionInput?.provider.kind === "openai_dot"
        || (!persistedNativeExecutionInput && agent.adapterType === "paperclip_runner" && parseObject(agent.adapterConfig).provider === "openai_dot");
      const persistedNativeExecutionWorkspaceId =
        persistedNativeExecutionInput?.binding.executionWorkspaceId ?? null;
      const requestedExecutionWorkspaceId =
        persistedNativeExecutionWorkspaceId ??
        readNonEmptyString(issueRef?.executionWorkspaceId);
      const existingExecutionWorkspace = requestedExecutionWorkspaceId
        ? await executionWorkspacesSvc.getById(requestedExecutionWorkspaceId)
        : null;
      const nativeRecoveryExecutionWorkspaceId =
        resolveNativeRecoveryExecutionWorkspaceBinding({
          bindingId: persistedNativeExecutionWorkspaceId,
          persistedWorkspaceFound: existingExecutionWorkspace !== null,
        });
      const workspaceReuseRequest =
        resolveExecutionWorkspaceReuseRequestForIssue({
          issueExecutionWorkspaceId: requestedExecutionWorkspaceId,
          issueExecutionWorkspacePreference: nativeRecoveryExecutionWorkspaceId
            ? "reuse_existing"
            : (issueRef?.executionWorkspacePreference ?? null),
          existingExecutionWorkspaceStatus:
            existingExecutionWorkspace?.status ?? null,
        });
      const requestedShouldReuseExisting =
        workspaceReuseRequest.requestedShouldReuseExisting;
      const reusableExistingExecutionWorkspace =
        workspaceReuseRequest.existingExecutionWorkspaceAvailable
          ? existingExecutionWorkspace
          : null;
      const requestedReusableExecutionWorkspaceConfig =
        reusableExistingExecutionWorkspace?.config ?? null;
      const localEnvironment = await environmentsSvc.ensureLocalEnvironment(
        agent.companyId,
      );
      const resolvedInstanceSettings = await instanceSettings.get();
      // Managed-sandbox-only policy: a run that would land on the local
      // environment is redirected onto the platform-managed sandbox row, and
      // with no active managed row the resolution fails closed
      // (ManagedSandboxUnavailableError) — never local. Mirrors the forced
      // kubernetes execution mode below, which takes precedence when both
      // regimes are active.
      const managedSandboxOnly =
        (await instanceSettings.getExperimental()).enableManagedSandboxOnly ===
        true;
      const managedSandboxEnvironment = managedSandboxOnly
        ? await environmentsSvc.findManagedSandboxEnvironment(agent.companyId)
        : null;
      const environmentResolution = resolveExecutionWorkspaceEnvironmentId({
        agentDefaultEnvironmentId: agent.defaultEnvironmentId,
        instanceDefaultEnvironmentId:
          resolvedInstanceSettings.defaultEnvironmentId ?? null,
        localDefaultEnvironmentId: localEnvironment.id,
        managedSandboxOnly,
        managedSandboxEnvironmentId: managedSandboxEnvironment?.id ?? null,
      });
      const effectiveExecutionWorkspaceMode: ReturnType<
        typeof resolveExecutionWorkspaceMode
      > = requestedExecutionWorkspaceMode;
      const executionPolicy = {
        executionMode: resolvedInstanceSettings.general.executionMode,
        // Backstop behind the resolver's local→managed redirect: the run-time
        // allowlist below fails any run that still resolved to a `local`
        // environment under managed-sandbox-only, so no selection path or
        // tenant-set env var can land untrusted execution on the tenant
        // container.
        managedSandboxOnly,
      };
      const executionForcedToKubernetes =
        isExecutionForcedToKubernetes(executionPolicy);
      let selectedEnvironmentId = environmentResolution.environmentId;
      if (executionForcedToKubernetes) {
        let kubernetesEnvironment =
          await environmentsSvc.findKubernetesEnvironment(agent.companyId);
        if (!kubernetesEnvironment) {
          // Lazy recovery for companies created after the startup bootstrap ran
          // (the boot hook only provisions environments for companies that exist
          // at boot). Re-derive the managed-env config from the bootstrap env.
          // If the process env no longer forces Kubernetes (rollback / config
          // drift relative to the persisted executionMode setting), skip the
          // provisioning gracefully: the guard below still refuses local
          // fallback with the explicit error, instead of crashing here on
          // undefined config.
          let bootstrap: ReturnType<typeof parseExecutionPolicyBootstrapEnv> =
            null;
          let bootstrapSkipReason: string | null = null;
          try {
            bootstrap = parseExecutionPolicyBootstrapEnv(process.env);
            if (!bootstrap) {
              bootstrapSkipReason =
                'PAPERCLIP_EXECUTION_MODE bootstrap env is not kubernetes-forced (absent or "any")';
            }
          } catch (err) {
            bootstrapSkipReason = `PAPERCLIP_EXECUTION_MODE bootstrap env failed to parse: ${
              err instanceof Error ? err.message : String(err)
            }`;
          }
          if (bootstrap) {
            await environmentsSvc.ensureKubernetesEnvironment(
              agent.companyId,
              bootstrap.kubernetesConfig,
            );
            kubernetesEnvironment =
              await environmentsSvc.findKubernetesEnvironment(agent.companyId);
          } else {
            logger.warn(
              {
                runId: run.id,
                agentId: agent.id,
                companyId: agent.companyId,
                reason: bootstrapSkipReason,
              },
              "executionMode=kubernetes is persisted but the bootstrap env cannot provision a managed Kubernetes environment; skipping lazy provisioning for this company (the run will fail with the explicit no-managed-environment error)",
            );
          }
        }
        if (!kubernetesEnvironment) {
          throw new Error(
            "Instance execution policy requires the Kubernetes sandbox provider " +
              "(executionMode=kubernetes) but no managed Kubernetes environment is " +
              "configured for this company. Configure one (PAPERCLIP_K8S_* env on the " +
              "cloud instance) before running agents; refusing to fall back to local execution.",
          );
        }
        if (kubernetesEnvironment.id !== selectedEnvironmentId) {
          logger.info(
            {
              runId: run.id,
              issueId,
              agentId: agent.id,
              resolvedEnvironmentId: selectedEnvironmentId,
              forcedKubernetesEnvironmentId: kubernetesEnvironment.id,
            },
            "Forcing run onto the managed Kubernetes environment (executionMode=kubernetes)",
          );
        }
        selectedEnvironmentId = kubernetesEnvironment.id;
      }
      const selectedEnvironmentForConfig =
        selectedEnvironmentId === localEnvironment.id
          ? localEnvironment
          : selectedEnvironmentId
            ? await environmentsSvc.getById(selectedEnvironmentId)
            : null;
      const nativeChatWorkspaceScope = await findNativeChatWorkspaceScope(db, {
        adapterType: agent.adapterType,
        environmentDriver: selectedEnvironmentForConfig?.driver ?? null,
        companyId: agent.companyId,
        agentId: agent.id,
        issueId,
      });
      const nativeChatExpectedCwd = nativeChatWorkspaceScope
        ? nativeChatWorkspaceCwd(
            nativeChatWorkspaceScope,
            reusableExistingExecutionWorkspace,
            requestedShouldReuseExisting,
          )
        : null;
      if (
        nativeChatWorkspaceScope &&
        persistedNativeExecutionInput &&
        persistedNativeExecutionInput.schema !== "paperclip.native-execution-input.v6" &&
        !nativeChatWorkspaceMatches({
          scope: nativeChatWorkspaceScope,
          expectedCwd: nativeChatExpectedCwd,
          execution: persistedNativeExecutionInput,
        })
      ) {
        // Never rewrite an admitted provider input or release ownership of an
        // older process whose permissions still include the shared agent home.
        throw new NativeRunnerOwnershipUnverifiedError(
          "native_chat_workspace_scope_mismatch",
        );
      }
      if (
        nativeChatWorkspaceScope &&
        (!nativeChatExpectedCwd ||
          executionProjectId !== nativeChatWorkspaceScope.projectId)
      ) {
        throw new ConfigurationIncompleteFailure(
          "External chat requires a task-owned isolated workspace. Configure and select an existing isolated worktree for this project task; shared project workspaces cannot be used for external chat.",
          {
            configurationIncomplete: {
              reason: "native_chat_workspace_isolation_required",
              issueId,
            },
          },
        );
      }
      const sharedWorkspaceConcurrency = resolveSharedWorkspaceConcurrency({
        projectPolicy: projectExecutionWorkspacePolicy,
        issueSettings: issueExecutionWorkspaceSettings,
      });
      // A live holder is always consulted for shared workspaces. Depending on policy and the final
      // execution target it either remains the existing deferral gate or becomes dispatch context.
      // Local/SSH folders never take an exclusive workspace lock, including when older
      // project or issue settings request serialization. Sandbox protection still uses
      // the existing holder staleness and workspace_busy retry ladder.
      if (
        issueRef?.projectWorkspaceId &&
        effectiveExecutionWorkspaceMode === "shared_workspace"
      ) {
        const workspaceHolder = await findSharedWorkspaceHolder({
          companyId: agent.companyId,
          projectWorkspaceId: issueRef.projectWorkspaceId,
          excludeIssueId: issueRef.id,
          excludeRunId: run.id,
          honorIsolatedWorkspaceModes: isolatedWorkspacesEnabled,
        });
        if (workspaceHolder) {
          const environmentDriver =
            selectedEnvironmentForConfig?.driver ?? null;
          const shouldSerialize =
            sharedWorkspaceConcurrency !== "allow" &&
            (executionForcedToKubernetes ||
              (environmentDriver !== "local" &&
                environmentDriver !== "ssh"));
          if (shouldSerialize) {
            throw new WorkspaceBusyDeferral({
              holder: workspaceHolder,
              projectWorkspaceId: issueRef.projectWorkspaceId,
              deferralAttempt:
                run.scheduledRetryReason === WORKSPACE_BUSY_RETRY_REASON
                  ? (run.scheduledRetryAttempt ?? 0)
                  : 0,
              wasIssueAssignee: issueContext?.assigneeAgentId === agent.id,
            });
          }

          const holderIssueLabel =
            workspaceHolder.issueIdentifier ?? workspaceHolder.issueId;
          const concurrentWorkspaceNote =
            `shared workspace is concurrently held by run ${workspaceHolder.runId} (issue ${holderIssueLabel}); ` +
            "expect concurrent mutations, coordinate via commits";
          const appendConcurrentWorkspaceNote = (value: unknown) => {
            const existing = typeof value === "string" ? value.trimEnd() : "";
            return existing
              ? `${existing}\n${concurrentWorkspaceNote}`
              : concurrentWorkspaceNote;
          };
          context.paperclipTaskMarkdown = appendConcurrentWorkspaceNote(
            context.paperclipTaskMarkdown,
          );
          context.paperclipTaskMarkdownAssignment = appendConcurrentWorkspaceNote(
            context.paperclipTaskMarkdownAssignment,
          );
          if (typeof context.paperclipTaskMarkdownCompact === "string") {
            context.paperclipTaskMarkdownCompact =
              appendConcurrentWorkspaceNote(
                context.paperclipTaskMarkdownCompact,
              );
          }
          if (typeof context.paperclipTaskMarkdownAssignmentCompact === "string") {
            context.paperclipTaskMarkdownAssignmentCompact =
              appendConcurrentWorkspaceNote(
                context.paperclipTaskMarkdownAssignmentCompact,
              );
          }
          logger.info(
            {
              event: "shared_workspace_concurrent_dispatch",
              runId: run.id,
              issueId: issueRef.id,
              projectWorkspaceId: issueRef.projectWorkspaceId,
              holderRunId: workspaceHolder.runId,
              holderIssueId: workspaceHolder.issueId,
              sharedWorkspaceConcurrency,
              environmentDriver,
              executionForcedToKubernetes,
            },
            "Dispatching alongside a live shared-workspace holder",
          );
        }
      }
      const useIsolatedTaskDirectory = issueRef !== null && shouldUseIsolatedTaskDirectory({
        trustPreset: trustPreset.kind,
        environmentDriver: selectedEnvironmentForConfig?.driver ?? null,
        mode: requestedExecutionWorkspaceMode,
        hasProjectWorkspace: projectContext?.hasWorkspace ?? false,
        projectWorkspaceId: issueRef.projectWorkspaceId,
        workspaceStrategies: [
          config.workspaceStrategy,
          issueAssigneeOverrides?.adapterConfig?.workspaceStrategy,
          projectExecutionWorkspacePolicy?.workspaceStrategy,
          issueExecutionWorkspaceSettings?.workspaceStrategy,
        ],
      });
      const workspaceManagedConfig = buildExecutionWorkspaceAdapterConfig({
        agentConfig: config,
        projectPolicy: projectExecutionWorkspacePolicy,
        issueSettings: issueExecutionWorkspaceSettings,
        mode: requestedExecutionWorkspaceMode,
        legacyUseProjectWorkspace:
          issueAssigneeOverrides?.useProjectWorkspace ?? null,
      });
      const mergedConfig = {
        ...workspaceManagedConfig,
        ...Object.fromEntries(Object.entries(issueAssigneeOverrides?.adapterConfig ?? {}).filter(([key]) => requestedAiBinding?.mode !== "router" || !["provider", "acpxAgent", "model", "modelReasoningEffort", "reasoningEffort", "effort", "variant"].includes(key))),
        ...(requestedAiBinding?.mode === "router" ? parseObject(parseObject(context.aiRouterSelection).runtimeConfig) : {}),
        // The base below is already task-owned. Keep directory transport while
        // preserving isolated mode and the mandatory sandbox preflight.
        ...(useIsolatedTaskDirectory ? { workspaceStrategy: { type: "project_primary" } } : {}),
      };
      const configSnapshot = buildExecutionWorkspaceConfigSnapshot(
        mergedConfig,
        selectedEnvironmentId,
      );
      const executionRunConfig =
        stripWorkspaceRuntimeFromExecutionRunConfig(mergedConfig);
      const runScopedMentionedSkillKeys =
        await resolveRunScopedMentionedSkillKeys({
          db,
          companyId: agent.companyId,
          issueId,
          commentIds: extractWakeCommentIds(context),
        });
      const runScopedSkillKeys =
        acceptedPlanContinuationWake &&
        !acceptedPlanWakeRoutingDecision?.suppressAcceptedContinuation
          ? [...runScopedMentionedSkillKeys, ACCEPTED_PLAN_CONVERSION_SKILL_KEY]
          : runScopedMentionedSkillKeys;
      const githubSelection = await resolveManagedGitHubIdentitySelection(
        db,
        agent.companyId,
        {
          agentId: agent.id,
          responsibleUserId,
          allowStandingDelegation: false,
        },
      );
      const useHostGitHub =
        !githubSelection.configured &&
        trustPreset.kind === "standard" &&
        ["local", "ssh"].includes(
          selectedEnvironmentForConfig?.driver ?? "local",
        );

      const { resolvedConfig, configuredTaskEnvironment, secretKeys, secretManifest } =
        await resolveExecutionRunAdapterConfig({
          managedAiCredentials: Boolean(aiBinding),
          managedGitHubCredentials: !useHostGitHub,
          companyId: agent.companyId,
          agentId: agent.id,
          adapterType: agent.adapterType,
          issueId,
          heartbeatRunId: run.id,
          environmentId: selectedEnvironmentForConfig?.id ?? null,
          environmentEnv: aiBinding ? stripAiAuthBindings(selectedEnvironmentForConfig?.envVars) : selectedEnvironmentForConfig?.envVars ?? null,
          environmentDriver: selectedEnvironmentForConfig?.driver ?? null,
          projectId: projectContext?.id ?? null,
          routineId: routineEnvContext.routineId,
          responsibleUserId,
          executionRunConfig: aiBinding ? { ...executionRunConfig, env: stripAiAuthBindings(executionRunConfig.env) } : executionRunConfig,
          projectEnv: aiBinding ? stripAiAuthBindings(projectContext?.env) : projectContext?.env ?? null,
          routineEnv: aiBinding ? stripAiAuthBindings(routineEnvContext.env) : routineEnvContext.env,
          secretsSvc,
          trustPreset,
        });
      readFailureReportSecrets = () => collectRunFailureSecretValues(resolvedConfig.env, secretKeys);
      if (aiBinding) {
        try {
          managedAiRuntime = await prepareManagedAiRuntime(db, { companyId: agent.companyId, agentId: agent.id, responsibleUserId, adapterType: agent.adapterType, binding: aiBinding, config: resolvedConfig });
        } catch (error) {
          // Only fresh executions can receive a pre-provider wait receipt. A
          // persisted native input may already have provider effects to recover.
          if (isAiConnectionBusy(error) && !persistedNativeExecutionInput) {
            // Use the authority recorded by the locked admission gate, never
            // the issue's mutable assignee observed during runtime preparation.
            const authorizedNonAssigneeWake =
              parseObject(run.runnerProfileJson).aiConnectionNonAssigneeCommentWake === true ||
              (run.scheduledRetryReason === AI_CONNECTION_BUSY_RETRY_REASON &&
                isNonAssigneeWorkspaceBusyRetry(run.scheduledRetryReason, parseObject(run.contextSnapshot)));
            await finalizeAiConnectionBusyDeferral(run, error, !authorizedNonAssigneeWake);
            return;
          }
          if (responsibleUserId && issueId) {
            await connectionIntentService(db).request({ sub: agent.id, company_id: agent.companyId, run_id: run.id, responsible_user_id: responsibleUserId }, aiBinding.provider, { purpose: "ai" }).catch(() => {
              logger.warn({ runId: run.id, agentId: agent.id }, "Could not attach AI connection request; runtime configuration action remains available");
            });
          }
          throw new ConfigurationIncompleteFailure(error instanceof Error ? error.message : "Configure this agent’s AI connection", {
            configurationIncomplete: { reason: "ai_connection_unavailable", companyId: agent.companyId, agentId: agent.id, responsibleUserId,
              ...(!persistedNativeExecutionInput && readAiConnectionConfigurationFailure(error)
                ? { selectionFailure: readAiConnectionConfigurationFailure(error) } : {}),
              provider: aiBinding.provider, method: aiBinding.method, actionUrl: `/agents/${agent.id}/runtime`,
              fingerprint: `ai:${agent.id}:${responsibleUserId}:${JSON.stringify(aiBinding)}` },
          });
        }
        const savedAiAccount = parseObject(run.contextSnapshot?.aiConnection);
        if (persistedNativeExecutionInput && !managedAiSessionIdentityCompatible(
          savedAiAccount.sessionIdentity ?? savedAiAccount.identity,
          managedAiRuntime.sessionIdentity,
          managedAiRuntime.identity,
        )) {
          throw new ConfigurationIncompleteFailure("The AI account changed while this native run was suspended. Start a new execution.", { configurationIncomplete: { reason: "ai_connection_changed", actionUrl: `/agents/${agent.id}/runtime` } });
        }
        Object.assign(resolvedConfig, managedAiRuntime.config);
        for (const key of AI_AUTH_ENV_KEYS) secretKeys.add(key);
        context.aiConnection = { ...managedAiRuntime.attribution, accountName: managedAiRuntime.accountName, identity: managedAiRuntime.identity, sessionIdentity: managedAiRuntime.sessionIdentity };
        await db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ aiConnection: context.aiConnection, ...(context.aiRouterTaskKey ? { aiRouterTaskKey: context.aiRouterTaskKey } : {}), ...(context.aiRouterSelection ? { aiRouterSelection: context.aiRouterSelection } : {}) })}::jsonb` }).where(eq(heartbeatRuns.id, run.id));
      }
      if (secretManifest.length > 0) {
        context.paperclipSecrets = {
          manifest: secretManifest,
        };
      } else {
        delete context.paperclipSecrets;
      }
      const effectiveResolvedConfig = applyRunScopedMentionedSkillKeys(
        resolvedConfig,
        runScopedSkillKeys,
      );
      const runtimeSkillPreference = readPaperclipSkillSyncPreference(
        effectiveResolvedConfig,
      );
      const nativeRunnerPreparationSpans: NativeRunHistoricalSpan[] = [];
      const skillsPrepareStartedAtMs = Date.now();
      const runtimeSkillEntries = await (async () => {
        try {
          return await companySkills.listRuntimeSkillEntries(agent.companyId, {
            versionSelections: skillVersionSelectionMap(
              runtimeSkillPreference.desiredSkillEntries,
              {
                versionPinsEnabled:
                  resolvedInstanceSettings.experimental.enableBetaSkills ===
                  true,
              },
            ),
          });
        } catch (error) {
          if (agent.adapterType === "paperclip_runner") {
            await recordFailedSkillPreparation({
              runId: run.id,
              startedAtMs: skillsPrepareStartedAtMs,
              onEvent: async (event) => {
                await appendRunEvent(run, event);
              },
            });
          }
          throw error;
        }
      })();
      nativeRunnerPreparationSpans.push({
        name: "skills.prepare",
        parentName: "task.prepare",
        startedAtMs: skillsPrepareStartedAtMs,
        endedAtMs: Date.now(),
      });
      const connectorAssignments = await resolveConnectorAssignments(db, { companyId: agent.companyId, agentId: agent.id, runId: run.id, issueId: typeof context.issueId === "string" ? context.issueId : undefined });
      const connectorSkillConfig = await applyConnectorSkills(effectiveResolvedConfig, runtimeSkillEntries, connectorAssignments);
      // Both CLI adapters and native context materialization use the same resolved set.
      runtimeSkillEntries.splice(0, runtimeSkillEntries.length, ...connectorSkillConfig.paperclipRuntimeSkills);
      const connectorDelivery = await prepareConnectorSkillDelivery(connectorSkillConfig, agent.adapterType);
      // Always replace this runtime-only field; caller wake data cannot supply skills.
      context.paperclipWake = { ...parseObject(context.paperclipWake), connectorSkillInstructions: connectorDelivery.instructions };
      let runtimeConfig = await prepareConnectionInstructionDelivery({
        resolve: () => resolveAssignedConnectionInstructionsForRun(db, { companyId: agent.companyId, agentId: agent.id, runId: run.id }),
        context, config: connectorDelivery.config, native: agent.adapterType === "paperclip_runner",
      });
      const agentIdentity = supportsManagedAgentIdentity(agent.adapterType, agent.adapterConfig, run.runtimeMode === "native" ? run.driverKind : undefined)
        ? await agentIdentityService(db).ensureAgentIdentity(agent.companyId, agent.id)
        : undefined;
      identityRedactor = createAgentIdentityRedactor(agentIdentity?.privateKeyPem);
      if (agentIdentity) secretKeys.add("PAPERCLIP_AGENT_PRIVATE_KEY");
      const resolvedFailureSecrets = readFailureReportSecrets();
      readFailureReportSecrets = () => [
        ...resolvedFailureSecrets,
        ...identityRedactor.values,
        ...collectRunFailureSecretValues(runtimeConfig.env, secretKeys),
      ];
      const latestAgentConfigRevision = await getLatestAgentConfigRevision(
        agent.companyId,
        agent.id,
      );
      const sessionConfigMetadataInput = {
          agentIdentityKeyId: agentIdentity?.keyId,
          adapterType: agent.adapterType,
          effectiveAdapterConfig: runtimeConfig,
          managedAiHome: managedAiRuntime?.home,
          agentRuntimeConfig: agent.runtimeConfig,
          issueOverrides: issueAssigneeOverrides,
          workspaceConfig: {
            requestedMode: requestedExecutionWorkspaceMode,
            effectiveMode: effectiveExecutionWorkspaceMode,
            issueConfigRevisionAt:
              issueContext?.updatedAt instanceof Date
                ? issueContext.updatedAt.toISOString()
                : (issueContext?.updatedAt ?? null),
            projectConfigRevisionAt:
              projectContext?.updatedAt instanceof Date
                ? projectContext.updatedAt.toISOString()
                : (projectContext?.updatedAt ?? null),
            projectPolicy: projectExecutionWorkspacePolicy,
            issueSettings: issueExecutionWorkspaceSettings,
            reusableExecutionWorkspaceConfig:
              requestedReusableExecutionWorkspaceConfig,
            existingExecutionWorkspace: reusableExistingExecutionWorkspace
              ? {
                  id: reusableExistingExecutionWorkspace.id,
                  mode: reusableExistingExecutionWorkspace.mode,
                  strategyType: reusableExistingExecutionWorkspace.strategyType,
                  projectWorkspaceId:
                    reusableExistingExecutionWorkspace.projectWorkspaceId,
                  repoUrl: reusableExistingExecutionWorkspace.repoUrl,
                  baseRef: reusableExistingExecutionWorkspace.baseRef,
                  branchName: reusableExistingExecutionWorkspace.branchName,
                  config: reusableExistingExecutionWorkspace.config,
                }
              : null,
          },
          environment: {
            selectionSource: environmentResolution.source,
            selectedEnvironmentId,
            selectedEnvironment: selectedEnvironmentForConfig
              ? {
                  id: selectedEnvironmentForConfig.id,
                  driver: selectedEnvironmentForConfig.driver,
                  config: selectedEnvironmentForConfig.config,
                  configRevisionAt:
                    selectedEnvironmentForConfig.updatedAt instanceof Date
                      ? selectedEnvironmentForConfig.updatedAt.toISOString()
                      : (selectedEnvironmentForConfig.updatedAt ?? null),
                }
              : null,
            executionPolicy,
          },
          environmentEnv: selectedEnvironmentForConfig?.envVars ?? null,
          projectEnv: projectContext?.env ?? null,
          routineEnv: routineEnvContext.env,
          secretManifest,
          runtimeSkills: runtimeSkillEntries,
          agentConfigRevision: latestAgentConfigRevision
            ? {
                id: latestAgentConfigRevision.id,
                changedKeys: latestAgentConfigRevision.changedKeys,
                configRevisionAt:
                  latestAgentConfigRevision.createdAt.toISOString(),
              }
            : null,
        };
      const sessionConfigMetadata = await buildEffectiveRunSessionConfigMetadata(sessionConfigMetadataInput);
      let compatibleConfigMetadata: EffectiveRunSessionConfigMetadata[] = [];
      if (managedAiRuntime && aiBinding && taskSession &&
        readConfigFingerprintFromSessionParams(taskSession.sessionParamsJson)?.fingerprint !== sessionConfigMetadata.fingerprint) {
        const revisions = requestedAiBinding?.mode === "router"
          ? await db.select().from(agentConfigRevisions).where(and(eq(agentConfigRevisions.companyId, agent.companyId), eq(agentConfigRevisions.agentId, agent.id))).orderBy(desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id)).limit(21)
          : [];
        const candidates = aiConnectionSessionCompatibilityInputs({
          effectiveAdapterConfig: runtimeConfig, agentRuntimeConfig: agent.runtimeConfig,
          agentConfigRevision: sessionConfigMetadataInput.agentConfigRevision,
          issueOverrides: issueAssigneeOverrides, originalIssueOverrides: originalAiIssueOverrides,
          binding: aiBinding, router: requestedAiBinding?.mode === "router",
          storedIdentity: taskSession.sessionParamsJson?.paperclipAiCredentialIdentity,
          sessionIdentity: managedAiRuntime.sessionIdentity, credentialIdentity: managedAiRuntime.identity, revisions,
        });
        compatibleConfigMetadata = await Promise.all(candidates.map(candidate => buildEffectiveRunSessionConfigMetadata({ ...sessionConfigMetadataInput, ...candidate })));
      }
      const configuredModel =
        readConfiguredModelFromAdapterConfig(runtimeConfig);
      if (context.refreshTools === true && agent.adapterType !== "paperclip_runner") {
        const capability = getServerAdapter(agent.adapterType).supportsToolRefreshOnResume;
        const canRefresh = typeof capability === "function" ? capability(runtimeConfig) : capability === true;
        if (!canRefresh) context.forceFreshSession = true;
      }
      const wakeSessionResetReason = describeSessionResetReason(context);
      const sessionConfigFreshness = resolveTaskSessionConfigFreshness({
        hasTaskSession: taskSession != null,
        configuredModel,
        taskSessionParams:
          taskSession?.sessionParamsJson ?? taskSessionDecodedParams,
        configMetadata: sessionConfigMetadata,
        compatibleConfigMetadata,
        wakeResetReason: wakeSessionResetReason,
        preserveLegacySessionWithoutConfigMetadata:
          acceptedPlanContinuationWake && !acceptedPlanWakeRoutingDecision && !agentIdentity,
      });
      const resetTaskSession =
        shouldResetTaskSessionForWake(context) || sessionConfigFreshness.reset;
      const sessionResetReason =
        sessionConfigFreshness.reasons.join("; ") || null;
      const taskSessionForRun = resetTaskSession ? null : taskSession;
      const getFreshSessionHandoff = issueRef ? createNativeSessionHandoffLoader({
        db, companyId: agent.companyId, issueId: issueRef.id, agentId: agent.id, before: run.createdAt,
        throughCommentId: readNonEmptyString(context.conversationReplayThroughCommentId) ?? (context.interactionKind ? null : wakeCommentId),
      }) : undefined;
      const previousSessionParams =
        explicitResumeSessionParams ??
        (isCanonicalSessionIdForAdapter(
          agent.adapterType,
          explicitResumeSessionDisplayId,
        )
          ? { sessionId: explicitResumeSessionDisplayId }
          : null) ??
        normalizeResumeParamsForAdapter(
          agent.adapterType,
          stripPaperclipSessionMetadataFromSessionParams(
            sessionCodec.deserialize(
              taskSessionForRun?.sessionParamsJson ?? null,
            ),
          ),
        );
      // Legacy plugins can consume the existing context field on a known-fresh
      // dispatch. Built-ins also load lazily if their resume attempt fails.
      if (agent.adapterType !== "paperclip_runner" && !previousSessionParams && getFreshSessionHandoff) {
        const handoff = await getFreshSessionHandoff();
        if (handoff) context.paperclipFreshSessionHandoffMarkdown = handoff;
      }
      const {
        selectedEnvironmentDriver: lowTrustPreflightEnvironmentDriver,
        workspace: resolvedWorkspace,
      } = await resolveWorkspaceAfterLowTrustPreflight({
        db,
        trustPreset,
        isolatedWorkspacesEnabled,
        effectiveExecutionWorkspaceMode,
        issue: issueRef
          ? {
              companyId: agent.companyId,
              id: issueRef.id,
              projectId: issueRef.projectId,
            }
          : null,
        resolveSelectedEnvironmentDriver: async () => {
          const preflightEnvironment = await envOrchestrator.resolveEnvironment(
            {
              companyId: agent.companyId,
              selectedEnvironmentId,
              localEnvironmentId: localEnvironment.id,
            },
          );
          return preflightEnvironment.driver;
        },
        resolveWorkspace: async () => {
          if (isDotRun) {
            // This is private controller storage, never a provider filesystem.
            // v6 projects workspace.access=none and cwd=null to Dot.
            const cwd = path.resolve(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "dot-controllers", agent.companyId, run.id);
            await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
            return { cwd, source: "agent_home" as const, projectId: null, workspaceId: null, repoUrl: null, repoRef: null,
              workspaceHints: [], warnings: [], baseCwdFallback: false, materializationFailures: [], additionalWorkspaces: [], referencedProjectFailures: [] };
          }
          if (useIsolatedTaskDirectory && issueRef) {
            const cwd = await materializeIsolatedTaskDirectory({
              companyId: agent.companyId,
              issueId: issueRef.id,
            });
            if (reusableExistingExecutionWorkspace && (
              reusableExistingExecutionWorkspace.companyId !== agent.companyId ||
              reusableExistingExecutionWorkspace.projectId !== issueRef.projectId ||
              reusableExistingExecutionWorkspace.sourceIssueId !== issueRef.id ||
              reusableExistingExecutionWorkspace.mode !== "isolated_workspace" ||
              reusableExistingExecutionWorkspace.strategyType !== "project_primary" ||
              reusableExistingExecutionWorkspace.cwd !== cwd
            )) {
              throw new WorkspaceValidationFailure("The existing execution workspace is not this task's isolated directory.", {
                workspaceValidation: { reason: "isolated_task_directory_binding_mismatch", issueId: issueRef.id },
              });
            }
            return resolveWorkspaceForRun(agent, context, previousSessionParams, {
              executionEnvironmentDriver: selectedEnvironmentForConfig?.driver ?? null,
              anchorWorkspace: {
                cwd,
                source: "task_session",
                projectId: issueRef.projectId,
                workspaceId: null,
                repoUrl: null,
                repoRef: null,
                workspaceHints: [],
                warnings: [],
                baseCwdFallback: false,
                materializationFailures: [],
              },
            });
          }
          if (nativeChatWorkspaceScope && !nativeChatWorkspaceScope.projectId) {
            const cwd = await materializeNativeChatTaskRoot(
              nativeChatWorkspaceScope,
            );
            return {
              cwd,
              source: "task_session" as const,
              projectId: null,
              workspaceId: null,
              repoUrl: null,
              repoRef: null,
              workspaceHints: [],
              warnings: [],
              baseCwdFallback: false,
              materializationFailures: [],
              additionalWorkspaces: [],
              referencedProjectFailures: [],
            };
          }
          const workspace = await resolveWorkspaceForRun(
            agent,
            context,
            previousSessionParams,
            {
              useProjectWorkspace:
                requestedExecutionWorkspaceMode !== "agent_default",
              anchorWorkspace: requestedShouldReuseExisting && reusableExistingExecutionWorkspace?.strategyType === "git_worktree"
                ? await resolveReusedGitWorkspaceAnchor({
                    agent,
                    workspace: reusableExistingExecutionWorkspace,
                    responsibleUserId,
                    immutableNativeBinding: Boolean(nativeRecoveryExecutionWorkspaceId),
                    projectId: nativeRecoveryExecutionWorkspaceId
                      ? reusableExistingExecutionWorkspace.projectId
                      : issueRef?.projectId ?? readNonEmptyString(context.projectId),
                    explicitProjectWorkspaceId: nativeRecoveryExecutionWorkspaceId
                      ? reusableExistingExecutionWorkspace.projectWorkspaceId
                      : readNonEmptyString(context.projectWorkspaceId),
                    issueId,
                    runId: run.id,
                  })
                : undefined,
              // Thread the selected environment driver so run-workspace resolution can tell a local
              // target from a remote one, and a confined sandbox target from an unconfined remote
              // target. A remote run resolves referenced projects only for the confined sandbox
              // transport with the remote flag on. This never changes the anchor workspace.
              executionEnvironmentDriver:
                selectedEnvironmentForConfig?.driver ?? null,
            },
          );
          // Additional referenced projects are a separate trusted Board
          // capability, not extra readable roots for an external conversation.
          return nativeChatWorkspaceScope
            ? {
                ...workspace,
                additionalWorkspaces: [],
                referencedProjectFailures: [],
              }
            : workspace;
        },
      });
      const hostExecutionWorkspaceConfig = isDotRun ? {} :
        stripHostWorkspaceProvisionForLowTrustSandbox({
          config: mergedConfig,
          trustPreset,
          selectedEnvironmentDriver: lowTrustPreflightEnvironmentDriver,
        });
      const executionWorkspaceBase = {
        baseCwd: resolvedWorkspace.cwd,
        source: resolvedWorkspace.source,
        projectId: resolvedWorkspace.projectId,
        workspaceId: resolvedWorkspace.workspaceId,
        repoUrl: resolvedWorkspace.repoUrl,
        repoRef: resolvedWorkspace.repoRef,
        additionalWorkspaces: resolvedWorkspace.additionalWorkspaces,
      } satisfies ExecutionWorkspaceInput;
      await assertGitWorktreeBaseWorkspaceReady({
        requestedExecutionWorkspaceMode,
        config: hostExecutionWorkspaceConfig,
        issue: issueRef,
        base: executionWorkspaceBase,
        anchor: {
          baseCwdFallback: resolvedWorkspace.baseCwdFallback,
          materializationFailures: resolvedWorkspace.materializationFailures,
          localPathOnlyWorkspace: resolvedWorkspace.localPathOnlyWorkspace,
        },
      });
      const workspaceStrategyForFingerprint = parseObject(
        hostExecutionWorkspaceConfig.workspaceStrategy,
      );
      const workspaceStrategyFingerprintValue =
        Object.keys(workspaceStrategyForFingerprint).length > 0
          ? workspaceStrategyForFingerprint
          : null;
      const latestWorkspaceStrategyType = resolveEffectiveWorkspaceStrategyType(
        requestedExecutionWorkspaceMode,
        hostExecutionWorkspaceConfig,
      );
      const selectedEnvironmentConfigForFingerprint = parseObject(
        selectedEnvironmentForConfig?.config,
      );
      const workspaceEnvironmentFingerprint = selectedEnvironmentForConfig
        ? {
            selectionSource: environmentResolution.source,
            selectedEnvironmentId,
            driver: selectedEnvironmentForConfig.driver,
            provider: readNonEmptyString(
              selectedEnvironmentConfigForFingerprint.provider,
            ),
            config: selectedEnvironmentForConfig.config,
            configRevisionAt:
              selectedEnvironmentForConfig.updatedAt instanceof Date
                ? selectedEnvironmentForConfig.updatedAt.toISOString()
                : (selectedEnvironmentForConfig.updatedAt ?? null),
            executionPolicy,
          }
        : null;
      const workspaceRealizationFingerprint = {
        environmentDriver: selectedEnvironmentForConfig?.driver ?? null,
        environmentProvider: readNonEmptyString(
          selectedEnvironmentConfigForFingerprint.provider,
        ),
        trustPreset: trustPreset.kind,
        lowTrustSandboxDriver: lowTrustPreflightEnvironmentDriver,
      };
      const workspaceFreshnessSource = resolvedWorkspace.freshnessSource ?? executionWorkspaceBase;
      const latestWorkspaceConfigMetadata =
        buildEffectiveRunWorkspaceConfigMetadata({
          mode: requestedExecutionWorkspaceMode,
          projectId: workspaceFreshnessSource.projectId,
          projectWorkspaceId: workspaceFreshnessSource.workspaceId,
          strategyType: latestWorkspaceStrategyType,
          workspaceStrategy: workspaceStrategyFingerprintValue,
          repoUrl: workspaceFreshnessSource.repoUrl,
          repoRef:
            readNonEmptyString(workspaceStrategyForFingerprint.baseRef) ??
            workspaceFreshnessSource.repoRef,
          configSnapshot,
          environment: workspaceEnvironmentFingerprint,
          realization: workspaceRealizationFingerprint,
          secretManifest,
        });
      const inferredExistingWorkspaceConfigMetadata =
        reusableExistingExecutionWorkspace
          ? buildEffectiveRunWorkspaceConfigMetadata({
              mode: issueExecutionWorkspaceModeForPersistedWorkspace(
                reusableExistingExecutionWorkspace.mode,
              ),
              projectId: reusableExistingExecutionWorkspace.projectId,
              projectWorkspaceId:
                reusableExistingExecutionWorkspace.projectWorkspaceId,
              strategyType: reusableExistingExecutionWorkspace.strategyType,
              workspaceStrategy: workspaceStrategyFingerprintValue
                ? {
                    ...workspaceStrategyFingerprintValue,
                    type: reusableExistingExecutionWorkspace.strategyType,
                    ...(reusableExistingExecutionWorkspace.baseRef
                      ? { baseRef: reusableExistingExecutionWorkspace.baseRef }
                      : {}),
                  }
                : { type: reusableExistingExecutionWorkspace.strategyType },
              repoUrl: reusableExistingExecutionWorkspace.repoUrl,
              repoRef: reusableExistingExecutionWorkspace.baseRef,
              configSnapshot: reusableExistingExecutionWorkspace.config,
              environment: workspaceEnvironmentFingerprint,
              realization: workspaceRealizationFingerprint,
              secretManifest,
              evaluatedAt: latestWorkspaceConfigMetadata.evaluatedAt,
            })
          : null;
      const workspaceConfigFreshness = resolveExecutionWorkspaceConfigFreshness(
        {
          hasExistingWorkspace:
            requestedShouldReuseExisting &&
            Boolean(reusableExistingExecutionWorkspace),
          existingWorkspaceMetadata:
            reusableExistingExecutionWorkspace?.metadata ?? null,
          inferredMetadata: inferredExistingWorkspaceConfigMetadata,
          nextMetadata: latestWorkspaceConfigMetadata,
        },
      );
      const workspaceReuseProvisioningPolicy =
        resolveExecutionWorkspaceReuseProvisioningPolicy({
          requestedShouldReuseExisting,
          workspaceConfigFreshness,
        });
      const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
        companyId: agent.companyId,
        heartbeatRunId: run.id,
        executionWorkspaceId:
          workspaceReuseProvisioningPolicy.shouldRestoreExistingWorkspace
            ? workspaceReuseRequest.requestedExecutionWorkspaceId
            : null,
        issueId,
      });
      // The run-scoped provider resolves the active identity at each Git operation,
      // including base-ref refreshes, workspace realization, and restore.
      const workspaceGitAuthProvider = createGitRemoteAuthProvider(
        db,
        agent.companyId,
        {
          issueId,
          heartbeatRunId: run.id,
          responsibleUserId: run.responsibleUserId,
          agentId: agent.id,
        },
      );
      const {
        executionWorkspace,
        reusedExecutionWorkspace,
        policy: resolvedWorkspaceReusePolicy,
      } = isDotRun ? { executionWorkspace: { ...executionWorkspaceBase, strategy: "project_primary" as const, cwd: resolvedWorkspace.cwd, branchName: null, worktreePath: null, warnings: [], created: false, branchCreatedByRuntime: false } as RealizedExecutionWorkspace, reusedExecutionWorkspace: false, policy: workspaceReuseProvisioningPolicy } : await provisionExecutionWorkspaceForFreshnessDecision<RealizedExecutionWorkspace>(
        {
          requestedShouldReuseExisting,
          existingExecutionWorkspaceId:
            workspaceReuseRequest.requestedExecutionWorkspaceId,
          issueRef,
          runId: run.id,
          workspaceConfigFreshness,
          restoreExistingWorkspace: reusableExistingExecutionWorkspace
            ? () =>
                ensurePersistedExecutionWorkspaceAvailable({
                  db,
                  base: executionWorkspaceBase,
                  workspace: {
                    id: reusableExistingExecutionWorkspace.id,
                    mode: reusableExistingExecutionWorkspace.mode,
                    strategyType:
                      reusableExistingExecutionWorkspace.strategyType,
                    cwd: reusableExistingExecutionWorkspace.cwd,
                    providerRef: reusableExistingExecutionWorkspace.providerRef,
                    projectId: reusableExistingExecutionWorkspace.projectId,
                    projectWorkspaceId:
                      reusableExistingExecutionWorkspace.projectWorkspaceId,
                    repoUrl: reusableExistingExecutionWorkspace.repoUrl,
                    baseRef: reusableExistingExecutionWorkspace.baseRef,
                    branchName: reusableExistingExecutionWorkspace.branchName,
                    metadata:
                      reusableExistingExecutionWorkspace.metadata as Record<
                        string,
                        unknown
                      > | null,
                    config: {
                      provisionCommand:
                        configSnapshot?.provisionCommand ??
                        reusableExistingExecutionWorkspace.config
                          ?.provisionCommand ??
                        projectExecutionWorkspacePolicy?.workspaceStrategy
                          ?.provisionCommand ??
                        null,
                      runtimeProvisionCommand:
                        configSnapshot?.runtimeProvisionCommand ??
                        reusableExistingExecutionWorkspace.config
                          ?.runtimeProvisionCommand ??
                        projectExecutionWorkspacePolicy?.workspaceStrategy
                          ?.runtimeProvisionCommand ??
                        null,
                    },
                  },
                  issue: issueRef,
                  agent: {
                    id: agent.id,
                    name: agent.name,
                    companyId: agent.companyId,
                  },
                  heartbeatRunId: run.id,
                  enableWorkspaceBranchReconcileForward:
                    resolvedInstanceSettings.experimental
                      .enableWorkspaceBranchReconcileForward,
                  enableWorkspaceDirtyQuarantineRepair:
                    resolvedInstanceSettings.experimental
                      .enableWorkspaceDirtyQuarantineRepair,
                  recorder: workspaceOperationRecorder,
                  resolveGitAuth: workspaceGitAuthProvider,
                })
            : null,
          realizeWorkspace: () =>
            realizeExecutionWorkspace({
              db,
              base: executionWorkspaceBase,
              config: hostExecutionWorkspaceConfig,
              issue: issueRef,
              agent: {
                id: agent.id,
                name: agent.name,
                companyId: agent.companyId,
              },
              recordedBranchOwnership:
                existingExecutionWorkspace?.status !== "archived" &&
                existingExecutionWorkspace?.branchName
                  ? {
                      branchName: existingExecutionWorkspace.branchName,
                      createdByRuntime: isRuntimeOwnedGitBranch(
                        existingExecutionWorkspace.metadata,
                      ),
                    }
                  : null,
              heartbeatRunId: run.id,
              enableWorkspaceBranchReconcileForward:
                resolvedInstanceSettings.experimental
                  .enableWorkspaceBranchReconcileForward,
              enableWorkspaceDirtyQuarantineRepair:
                resolvedInstanceSettings.experimental
                  .enableWorkspaceDirtyQuarantineRepair,
              recorder: workspaceOperationRecorder,
              resolveGitAuth: workspaceGitAuthProvider,
            }),
        },
      );
      const resolvedProjectId =
        executionWorkspace.projectId ??
        issueRef?.projectId ??
        executionProjectId ??
        null;
      const resolvedProjectWorkspaceId =
        resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace && reusableExistingExecutionWorkspace?.strategyType === "git_worktree"
          ? reusableExistingExecutionWorkspace.projectWorkspaceId
          : issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId ?? null;
      let persistedExecutionWorkspace: ExecutionWorkspace | null = null;
      let issueExecutionWorkspaceIdForRun =
        issueRef?.executionWorkspaceId ?? null;
      let issueProjectWorkspaceIdForRun = issueRef?.projectWorkspaceId ?? null;
      let issueExecutionWorkspacePreferenceForRun =
        issueRef?.executionWorkspacePreference ?? null;
      let issueExecutionWorkspaceModeForRun =
        issueExecutionWorkspaceSettings?.mode ?? null;
      const warmReusableExecutionWorkspace =
        selectedEnvironmentForConfig?.driver === "sandbox" &&
        selectedEnvironmentConfigForFingerprint.reuseLease === true &&
        selectedEnvironmentConfigForFingerprint.runnerLifecycleMode === "warm";
      // Native provider checkpoints bind to the workspace row, including ordinary
      // local shared workspaces. Persist that binding independently of the opt-in
      // isolated-workspace UI, just as warm sandbox continuity already does.
      const nativeSharedWorkspace = agent.adapterType === "paperclip_runner" &&
        requestedExecutionWorkspaceMode === "shared_workspace";
      const bindIssueToPersistedExecutionWorkspace = async (
        workspace: ExecutionWorkspace | null,
      ) => {
        if (!issueId || !workspace || nativeRecoveryExecutionWorkspaceId) {
          return;
        }
        const nextIssueWorkspaceMode =
          issueExecutionWorkspaceModeForPersistedWorkspace(workspace.mode) ??
          "agent_default";
        const shouldSwitchIssueToExistingWorkspace =
          issueRef?.executionWorkspacePreference === "reuse_existing" ||
          requestedExecutionWorkspaceMode === "isolated_workspace" ||
          requestedExecutionWorkspaceMode === "operator_branch" ||
          warmReusableExecutionWorkspace || nativeSharedWorkspace;
        const nextIssuePatch: Record<string, unknown> = {};
        if (issueExecutionWorkspaceIdForRun !== workspace.id) {
          nextIssuePatch.executionWorkspaceId = workspace.id;
        }
        if (
          resolvedProjectWorkspaceId &&
          issueProjectWorkspaceIdForRun !== resolvedProjectWorkspaceId
        ) {
          nextIssuePatch.projectWorkspaceId = resolvedProjectWorkspaceId;
        }
        if (
          shouldSwitchIssueToExistingWorkspace &&
          (issueExecutionWorkspacePreferenceForRun !== "reuse_existing" ||
            issueExecutionWorkspaceModeForRun !== nextIssueWorkspaceMode)
        ) {
          nextIssuePatch.executionWorkspacePreference = "reuse_existing";
          nextIssuePatch.executionWorkspaceSettings = {
            ...(issueExecutionWorkspaceSettings ?? {}),
            mode: nextIssueWorkspaceMode,
          };
        }
        if (Object.keys(nextIssuePatch).length > 0) {
          await issuesSvc.update(
            issueId,
            { ...nextIssuePatch, companyGuard: agent.companyId },
            db,
            undefined,
            undefined,
            { bindRuntimeSharedWorkspace: (warmReusableExecutionWorkspace || nativeSharedWorkspace) && workspace.mode === "shared_workspace" },
          );
          issueExecutionWorkspaceIdForRun = workspace.id;
          issueProjectWorkspaceIdForRun =
            resolvedProjectWorkspaceId ?? issueProjectWorkspaceIdForRun;
          if (shouldSwitchIssueToExistingWorkspace) {
            issueExecutionWorkspacePreferenceForRun = "reuse_existing";
            issueExecutionWorkspaceModeForRun = nextIssueWorkspaceMode;
          }
        }
      };
      const baseExecutionWorkspaceMetadata =
        mergeExecutionWorkspaceMetadataForPersistence({
          existingMetadata:
            resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace
              ? (reusableExistingExecutionWorkspace?.metadata ?? null)
              : null,
          source: executionWorkspace.source,
          // Attaching a new worktree to a pre-existing branch reports a fresh
          // workspace, but must not make cleanup own the operator's branch.
          createdByRuntime:
            resolveExecutionWorkspaceBranchOwnership(executionWorkspace),
          strategyType: executionWorkspace.strategy,
          configSnapshot,
          shouldReuseExisting:
            resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace,
          shouldRefreshConfigSnapshot:
            resolvedWorkspaceReusePolicy.shouldRefreshWorkspaceConfigSnapshot,
          workspaceConfigMetadata:
            resolvedWorkspaceReusePolicy.shouldPersistLatestWorkspaceConfigMetadata
              ? latestWorkspaceConfigMetadata
              : null,
          baseRef: executionWorkspace.repoRef,
          baseRefSha: executionWorkspace.baseRefSha ?? null,
        });
      let persistedWorktreeInstanceRoot =
        resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace &&
        typeof reusableExistingExecutionWorkspace?.metadata?.[
          WORKTREE_INSTANCE_ROOT_METADATA_KEY
        ] === "string"
          ? reusableExistingExecutionWorkspace.metadata[
              WORKTREE_INSTANCE_ROOT_METADATA_KEY
            ]
          : null;
      if (
        !persistedWorktreeInstanceRoot &&
        executionWorkspace.strategy === "git_worktree" &&
        executionWorkspace.worktreePath
      ) {
        try {
          persistedWorktreeInstanceRoot =
            (
              await readManagedWorktreeInstanceOwnership(
                executionWorkspace.worktreePath,
              )
            )?.instanceRoot ?? null;
        } catch (error) {
          logger.warn(
            {
              runId: run.id,
              issueId,
              executionWorkspaceCwd: executionWorkspace.cwd,
              error: error instanceof Error ? error.message : String(error),
            },
            "Could not record managed worktree instance ownership",
          );
        }
      }
      const nextExecutionWorkspaceMetadata = {
        ...baseExecutionWorkspaceMetadata,
        ...(persistedWorktreeInstanceRoot
          ? {
              [WORKTREE_INSTANCE_ROOT_METADATA_KEY]:
                persistedWorktreeInstanceRoot,
            }
          : {}),
      };
      const pendingForwardBranchReconcile =
        executionWorkspace.pendingForwardBranchReconcile ?? null;
      const branchNameForInitialPersistence =
        pendingForwardBranchReconcile?.recordedBranchName ??
        executionWorkspace.branchName;
      try {
        persistedExecutionWorkspace =
          resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace &&
          reusableExistingExecutionWorkspace
            ? await executionWorkspacesSvc.update(
                reusableExistingExecutionWorkspace.id,
                {
                  cwd: executionWorkspace.cwd,
                  repoUrl: executionWorkspace.repoUrl,
                  baseRef: executionWorkspace.repoRef,
                  branchName: branchNameForInitialPersistence,
                  providerType:
                    executionWorkspace.strategy === "git_worktree"
                      ? "git_worktree"
                      : "local_fs",
                  providerRef: executionWorkspace.worktreePath,
                  status: "active",
                  lastUsedAt: new Date(),
                  metadata: nextExecutionWorkspaceMetadata,
                  projectWorkspaceId:
                    reconcileReusedExecutionWorkspaceProjectWorkspaceId(
                      reusableExistingExecutionWorkspace.projectWorkspaceId,
                      resolvedProjectWorkspaceId,
                    ),
                },
              )
            : resolvedProjectId
              ? await executionWorkspacesSvc.create({
                  companyId: agent.companyId,
                  projectId: resolvedProjectId,
                  projectWorkspaceId: resolvedProjectWorkspaceId,
                  sourceIssueId: issueRef?.id ?? null,
                  mode:
                    requestedExecutionWorkspaceMode === "isolated_workspace"
                      ? "isolated_workspace"
                      : requestedExecutionWorkspaceMode === "operator_branch"
                        ? "operator_branch"
                        : requestedExecutionWorkspaceMode === "agent_default"
                          ? "adapter_managed"
                          : "shared_workspace",
                  strategyType:
                    executionWorkspace.strategy === "git_worktree"
                      ? "git_worktree"
                      : "project_primary",
                  name:
                    branchNameForInitialPersistence ??
                    issueRef?.identifier ??
                    `workspace-${agent.id.slice(0, 8)}`,
                  status: "active",
                  cwd: executionWorkspace.cwd,
                  repoUrl: executionWorkspace.repoUrl,
                  baseRef: executionWorkspace.repoRef,
                  branchName: branchNameForInitialPersistence,
                  providerType:
                    executionWorkspace.strategy === "git_worktree"
                      ? "git_worktree"
                      : "local_fs",
                  providerRef: executionWorkspace.worktreePath,
                  lastUsedAt: new Date(),
                  openedAt: new Date(),
                  metadata: nextExecutionWorkspaceMetadata,
                })
              : null;
      } catch (error) {
        if (executionWorkspace.created) {
          try {
            await cleanupExecutionWorkspaceArtifacts({
              workspace: {
                id:
                  reusableExistingExecutionWorkspace?.id ??
                  workspaceReuseRequest.requestedExecutionWorkspaceId ??
                  `transient-${run.id}`,
                cwd: executionWorkspace.cwd,
                providerType:
                  executionWorkspace.strategy === "git_worktree"
                    ? "git_worktree"
                    : "local_fs",
                providerRef: executionWorkspace.worktreePath,
                branchName: executionWorkspace.branchName,
                repoUrl: executionWorkspace.repoUrl,
                baseRef: executionWorkspace.repoRef,
                projectId: resolvedProjectId,
                projectWorkspaceId: resolvedProjectWorkspaceId,
                sourceIssueId: issueRef?.id ?? null,
                metadata: nextExecutionWorkspaceMetadata,
              },
              projectWorkspace: {
                cwd: resolvedWorkspace.cwd,
                cleanupCommand: null,
              },
              cleanupCommand: configSnapshot?.cleanupCommand ?? null,
              teardownCommand:
                configSnapshot?.teardownCommand ??
                projectExecutionWorkspacePolicy?.workspaceStrategy
                  ?.teardownCommand ??
                null,
              recorder: workspaceOperationRecorder,
            });
          } catch (cleanupError) {
            logger.warn(
              {
                runId: run.id,
                issueId,
                executionWorkspaceCwd: executionWorkspace.cwd,
                cleanupError:
                  cleanupError instanceof Error
                    ? cleanupError.message
                    : String(cleanupError),
              },
              "Failed to cleanup realized execution workspace after persistence failure",
            );
          }
        }
        throw error;
      }
      await workspaceOperationRecorder.attachExecutionWorkspaceId(
        persistedExecutionWorkspace?.id ?? null,
      );
      await recordWorkspaceConfigFreshnessOperation({
        recorder: workspaceOperationRecorder,
        runId: run.id,
        decision: workspaceConfigFreshness,
        hasExistingWorkspace: Boolean(reusableExistingExecutionWorkspace),
        reuseRequested: requestedShouldReuseExisting,
        workspaceReused: Boolean(reusedExecutionWorkspace),
        configSnapshotRefreshed:
          resolvedWorkspaceReusePolicy.shouldRefreshWorkspaceConfigSnapshot,
        previousWorkspaceId:
          workspaceReuseRequest.requestedExecutionWorkspaceId,
        activeWorkspaceId: persistedExecutionWorkspace?.id ?? null,
      });
      if (
        reusableExistingExecutionWorkspace &&
        persistedExecutionWorkspace &&
        reusableExistingExecutionWorkspace.id !==
          persistedExecutionWorkspace.id &&
        reusableExistingExecutionWorkspace.status === "active"
      ) {
        await executionWorkspacesSvc.update(
          reusableExistingExecutionWorkspace.id,
          {
            status: "idle",
            cleanupReason: null,
          },
        );
      }
      await bindIssueToPersistedExecutionWorkspace(persistedExecutionWorkspace);
      const projectRepositoryPaths: string[] = [];
      if (executionWorkspace.projectId && resolvedWorkspace.source === "project_primary" && !resolvedWorkspace.baseCwdFallback) {
        const repositoryRows = await db.select().from(projectWorkspaces).where(and(
          eq(projectWorkspaces.companyId, agent.companyId),
          eq(projectWorkspaces.projectId, executionWorkspace.projectId),
        )).orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
        const repositories = await prepareProjectRepositoryWorkspaces({
          cwd: executionWorkspace.cwd,
          anchorRepoUrl: executionWorkspace.repoUrl,
          workspaces: repositoryRows,
          resolveGitAuth: workspaceGitAuthProvider,
        });
        const paths = new Map(repositories.map((repo) => [repo.workspaceId, repo.cwd]));
        projectRepositoryPaths.push(...repositories.map((repo) => path.relative(executionWorkspace.cwd, repo.cwd)));
        if (resolvedWorkspace.workspaceId) paths.set(resolvedWorkspace.workspaceId, executionWorkspace.cwd);
        resolvedWorkspace.workspaceHints = resolvedWorkspace.workspaceHints.map((hint) => ({
          ...hint, cwd: paths.get(hint.workspaceId) ?? hint.cwd,
        }));
      }
      if (persistedExecutionWorkspace) {
        context.executionWorkspaceId = persistedExecutionWorkspace.id;
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: context,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
      }
      const environmentAcquireStartedAtMs = Date.now();
      let acquiredEnvironment: Awaited<
        ReturnType<typeof envOrchestrator.acquireForRun>
      >;
      try {
        await controllerLease.assertOwned();
        const remoteRecovery = runOptions.nativeRestartRecovery?.kind === "reattach_remote_runner"
          ? runOptions.nativeRestartRecovery : null;
        const recoveryWorkspace = remoteRecovery
          ? readNativeWorkspaceSyncReference(parseObject(run.runnerProfileJson).nativeWorkspaceSync) : null;
        if (remoteRecovery && (!recoveryWorkspace || remoteRecovery.runId !== run.id ||
            recoveryWorkspace.providerLeaseId !== remoteRecovery.remote.providerLeaseId ||
            recoveryWorkspace.remoteCwd !== remoteRecovery.remote.remoteCwd)) {
          throw new Error("native_remote_recovery_lease_mismatch");
        }
        acquiredEnvironment = await envOrchestrator.acquireForRun({
          companyId: agent.companyId,
          selectedEnvironmentId,
          localEnvironmentId: localEnvironment.id,
          adapterType: agent.adapterType,
          adapterConfig: parseObject(agent.adapterConfig),
          admittedLifecycleMode: persistedNativeExecutionInput?.session.lifecyclePolicy.mode,
          issueId: issueId ?? null,
          heartbeatRunId: run.id,
          agentId: agent.id,
          persistedExecutionWorkspace,
          executionWorkspaceSettings: environmentExecutionWorkspaceSettings,
          ...(remoteRecovery && recoveryWorkspace ? { reattachRemoteLease: {
            leaseId: recoveryWorkspace.leaseId,
            providerLeaseId: remoteRecovery.remote.providerLeaseId,
            remoteCwd: remoteRecovery.remote.remoteCwd,
          } } : {}),
        });
        await controllerLease.assertOwned();
        nativeRunnerPreparationSpans.push({
          name: "environment.acquire",
          parentName: "task.run",
          startedAtMs: environmentAcquireStartedAtMs,
          endedAtMs: Date.now(),
          attributes: { adapter: agent.adapterType },
        });
      } catch (error) {
        nativeRunnerPreparationSpans.push({
          name: "environment.acquire",
          parentName: "task.run",
          startedAtMs: environmentAcquireStartedAtMs,
          endedAtMs: Date.now(),
          outcome: "failed",
          attributes: { adapter: agent.adapterType },
        });
        throw error;
      }
      const selectedEnvironment = acquiredEnvironment.environment;
      // Defense-in-depth: re-check the actually-acquired environment against the
      // execution allowlist. Even if selection were bypassed, a denied (local/ssh/
      // non-k8s) environment FAILS the run here rather than executing untrusted.
      const allowlistDecision = evaluateExecutionAllowlist(executionPolicy, {
        driver: selectedEnvironment.driver,
        provider:
          typeof selectedEnvironment.config?.provider === "string"
            ? selectedEnvironment.config.provider
            : null,
      });
      if (!allowlistDecision.allowed) {
        logger.error(
          {
            runId: run.id,
            issueId,
            agentId: agent.id,
            environmentId: selectedEnvironment.id,
            deniedDriver: allowlistDecision.deniedDriver,
            deniedProvider: allowlistDecision.deniedProvider,
          },
          "Execution allowlist denied the resolved environment; failing run",
        );
        throw new Error(allowlistDecision.reason);
      }
      let activeEnvironmentLease = {
        environment: acquiredEnvironment.environment,
        lease: acquiredEnvironment.lease,
        leaseContext: acquiredEnvironment.leaseContext,
      };
      const duplexObservabilityRecorder = createHostDuplexObservabilityRecorder(
        {
          tracer: getStartupTracer(),
          incrementCounter: (metric) => {
            void incrementToolRuntimeMetricCounter(db, {
              companyId: run.companyId,
              metric,
            }).catch(() => {});
          },
          emitTransportEvent: (event) => {
            void (async () => {
              await appendRunEvent(run, {
                eventType: event.name,
                stream: "system",
                level: event.dimensions.outcome === "error" ? "warn" : "info",
                payload: { ...event.dimensions },
              });
            })().catch(() => {});
          },
        },
      );
      const environmentRealizeStartedAtMs = Date.now();
      let realizationResult: Awaited<
        ReturnType<typeof envOrchestrator.realizeForRun>
      >;
      try {
        realizationResult = await envOrchestrator.realizeForRun({
          environment: selectedEnvironment,
          lease: activeEnvironmentLease.lease,
          adapterType: agent.adapterType,
          companyId: agent.companyId,
          issueId: issueId ?? null,
          heartbeatRunId: run.id,
          executionWorkspace,
          effectiveExecutionWorkspaceMode,
          persistedExecutionWorkspace,
          duplexObservabilityRecorder,
        });
        nativeRunnerPreparationSpans.push({
          name: "environment.workspace.realize",
          parentName: "task.run",
          startedAtMs: environmentRealizeStartedAtMs,
          endedAtMs: Date.now(),
          attributes: { driver: selectedEnvironment.driver },
        });
      } catch (error) {
        nativeRunnerPreparationSpans.push({
          name: "environment.workspace.realize",
          parentName: "task.run",
          startedAtMs: environmentRealizeStartedAtMs,
          endedAtMs: Date.now(),
          outcome: "failed",
          attributes: { driver: selectedEnvironment.driver },
        });
        throw error;
      }
      const environmentRealizeEndedAtMs = Date.now();
      activeEnvironmentLease = {
        ...activeEnvironmentLease,
        lease: realizationResult.lease,
      };
      persistedExecutionWorkspace =
        realizationResult.persistedExecutionWorkspace;
      // A sandbox realization may materialize or replace the durable workspace
      // after the host-side provisioning boundary above. Bind that final ID to
      // the issue before dispatch so warm turns reuse the exact same workspace
      // and lease scope instead of silently creating a per-run replacement.
      await bindIssueToPersistedExecutionWorkspace(persistedExecutionWorkspace);
      const workspaceRealization = realizationResult.workspaceRealization;
      const executionTarget = realizationResult.executionTarget;
      let instructionCopy: Awaited<ReturnType<typeof instructionCopies.prepare>> = null;
      let instructionSave: Record<string, unknown> | null = null;
      const instructionPreparationKey = createHash("sha256").update(JSON.stringify({
        adapterType: agent.adapterType, adapterConfig: agent.adapterConfig, runtimeConfig: agent.runtimeConfig, sessionConfigMetadata,
        workspace: nativeSessionWorkspaceScope({
          binding: { runId: run.id, executionWorkspaceId: persistedExecutionWorkspace?.id ?? run.id },
          workspace: executionWorkspace,
        }), cwd: executionWorkspace.cwd,
      })).digest("hex");
      const recordInstructionSave = async (saved: NonNullable<Awaited<ReturnType<typeof instructionCopies.get>>>) => {
        const receipt = parseObject(saved.receipt);
        const storageWarning = readNonEmptyString(receipt.storageWarning);
        const state = saved.errorCode === "AGENT_FILES_CHECKPOINT_UNSTABLE" ? "pending_collection"
          : saved.state === "warm_saved" ? readNonEmptyString(receipt.checkpointState) ?? "saved" : saved.state;
        instructionSave = { state, entryFile: saved.entryFile,
          ...(isAgentDirectoryCopy(saved) ? { contract: "agent_files", appliedCandidateHash: saved.candidateHash, checkpointStats: receipt.checkpointStats }
            : { revisionId: parseObject(receipt.revision).id ?? null }), storageWarning, errorCode: saved.errorCode, errorMessage: saved.errorMessage };
        await appendRunEvent(run, { eventType: "instruction_save", stream: "system",
          level: !saved.errorCode && !storageWarning && ["saved", "unchanged", "resolved"].includes(state) ? "info" : "warn",
          message: storageWarning ?? (state === "saved" ? "Agent files saved."
            : state === "unchanged" ? "Instruction working copy is unchanged."
              : saved.errorMessage ?? "Instruction edits were not saved."), payload: instructionSave });
      };
      const collectStoppedInstructions = async () => {
        if (!instructionCopy) return;
        const saved = await collectStoppedInstructionCopyWithRetries(() => instructionCopies.collectStopped({
          companyId: agent.companyId, runId: run.id, target: executionTarget,
        }));
        if (!saved) return;
        if (saved.state !== "superseded") await recordInstructionSave(saved);
      };
      const nativeInstructionWorkingCopy = () => instructionCopy ? {
        ...(isAgentDirectoryCopy(instructionCopy) ? { runId: run.id, preparationKey: instructionPreparationKey } : {}),
        root: instructionCopy.executionRoot,
        ...(instructionCopy.receipt?.warm === true ? { checkpointWarm: async () => {
          const saved = await instructionCopies.checkpointWarm({ companyId: agent.companyId, runId: run.id, target: executionTarget });
          if (saved) await recordInstructionSave(saved);
          return saved?.state === "warm_saved" && saved.errorCode === null;
        } } : {}),
        hasChanges: () => instructionCopies.hasChanges({ companyId: agent.companyId, runId: run.id, target: executionTarget }),
        collectStopped: collectStoppedInstructions,
        retirementFailed: async () => { await instructionCopies.reportRetirementUnconfirmed(agent.companyId, run.id); },
      } : undefined;
      if (managedAiRuntime && aiBinding) {
        try { await assertManagedAiProjectAuth({ ...resolvedConfig, cwd: executionWorkspace.cwd }, aiBinding.provider, executionTarget); }
        catch { throw new ConfigurationIncompleteFailure("Project authentication conflicts with this agent’s managed AI connection", { configurationIncomplete: { reason: "ai_connection_incompatible", actionUrl: `/agents/${agent.id}/runtime` } }); }
      }
      const remoteExecution = realizationResult.remoteExecution;
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
      ): Promise<
        { dispatched: true; resultPromise: Promise<T> } | { dispatched: false }
      > => {
        await controllerLease.assertOwned("dispatching");
        // Recheck after workspace/credential preparation, immediately before the
        // provider handoff. Never hold validation locks while adapter code runs.
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
        if (
          !issueId ||
          (!isResolvedInteractionContinuationWakeContext(context) &&
            !["native_safe_replacement", "native_provider_overloaded"].includes(run.scheduledRetryReason ?? ""))
        ) {
          return { dispatched: true, resultPromise: dispatch(() => {}) };
        }
        await options.beforeResolvedInteractionContinuationDispatchCheck?.({
          runId: run.id,
          issueId,
        });

        await options.afterResolvedInteractionContinuationDispatchCheck?.({
          runId: run.id,
          issueId,
        });
        const gate = await runDispatch.dispatchResolvedInteractionIfCurrent({
          runId: run.id,
          companyId: run.companyId,
          expectedStatus: "running",
          // Synchronous handoff under the ownership lock; the gate commits
          // without awaiting the adapter's asynchronous bootstrap or finalizer.
          dispatch,
        });

        if (gate.dispatched) return gate;
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
        const reservation = await reserveRunBudget(db, run.companyId, run.id,
          readNonEmptyString(runLedgerScope.projectId), runLedgerScope, runOptions.nativeLeaseOwner);
        let entered = false;
        try {
          return await dispatchResolvedInteractionContinuationAfterAdmission((markDispatchStarted) => {
            entered = true;
            return dispatch(markDispatchStarted);
          });
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
      const gitExecutionEnv = await prepareGitHubExecutionEnvironment({
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
      });
      runtimeConfig = { ...runtimeConfig, env: gitExecutionEnv };
      for (const key of MANAGED_GITHUB_TOKEN_KEYS) secretKeys.add(key);
      context.githubAuthenticationMode = useHostGitHub ? "host" : "managed";
      if (!useHostGitHub) {
        const githubLaunchers = await prepareHeartbeatGitHubLaunchers({
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
        });
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
          syncedProjectIds: resolvedWorkspace.additionalWorkspaces.map(
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
      const runtimeServiceIntents = (() => {
        const runtimeConfig = parseObject(
          hostExecutionWorkspaceConfig.workspaceRuntime,
        );
        return Array.isArray(runtimeConfig.services)
          ? runtimeConfig.services.filter(
              (value): value is Record<string, unknown> =>
                typeof value === "object" && value !== null,
            )
          : [];
      })();
      assertLowTrustRuntimeServicesAllowed({
        resolution: trustPreset,
        runtimeServiceCount: runtimeServiceIntents.length,
      });
      if (runtimeServiceIntents.length > 0) {
        context.paperclipRuntimeServiceIntents = runtimeServiceIntents;
      } else {
        delete context.paperclipRuntimeServiceIntents;
      }
      if (
        executionWorkspace.projectId &&
        !readNonEmptyString(context.projectId)
      ) {
        context.projectId = executionWorkspace.projectId;
      }
      const runtimeSessionFallback =
        taskKey || resetTaskSession
          ? null
          : isCanonicalSessionIdForAdapter(agent.adapterType, runtime.sessionId)
            ? runtime.sessionId
            : null;
      const runtimeSessionDisplayId = truncateDisplayId(
        explicitResumeSessionDisplayId ??
          taskSessionForRun?.sessionDisplayId ??
          (sessionCodec.getDisplayId
            ? sessionCodec.getDisplayId(runtimeSessionParams)
            : null) ??
          readNonEmptyString(runtimeSessionParams?.sessionId) ??
          runtimeSessionFallback,
      );
      let previousSessionDisplayId = requiresCanonicalSessionIds(
        agent.adapterType,
      )
        ? truncateDisplayId(
            readNonEmptyString(previousSessionParams?.sessionId) ??
              (isCanonicalSessionIdForAdapter(
                agent.adapterType,
                runtimeSessionDisplayId,
              )
                ? runtimeSessionDisplayId
                : null) ??
              runtimeSessionFallback,
          )
        : runtimeSessionDisplayId;
      let runtimeSessionIdForAdapter =
        readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback;
      let runtimeSessionParamsForAdapter = normalizeSessionParams(
        stripPaperclipSessionMetadataFromSessionParams(runtimeSessionParams),
      );

      const sessionCompaction = await evaluateSessionCompaction({
        agent,
        sessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
        issueId,
        continuationSummaryBody: continuationSummary?.body ?? null,
      });
      if (sessionCompaction.rotate) {
        context.paperclipSessionHandoffMarkdown =
          sessionCompaction.handoffMarkdown;
        context.paperclipSessionRotationReason = sessionCompaction.reason;
        context.paperclipPreviousSessionId =
          previousSessionDisplayId ?? runtimeSessionIdForAdapter;
        runtimeSessionIdForAdapter = null;
        runtimeSessionParamsForAdapter = null;
        previousSessionDisplayId = null;
        if (sessionCompaction.reason) {
          runtimeWorkspaceWarnings.push(
            `Starting a fresh session because ${sessionCompaction.reason}.`,
          );
        }
      } else {
        delete context.paperclipSessionHandoffMarkdown;
        delete context.paperclipSessionRotationReason;
        delete context.paperclipPreviousSessionId;
      }

      const taskSessionCredentialCompatible = !managedAiRuntime || managedAiSessionIdentityCompatible(
        taskSession?.sessionParamsJson?.paperclipAiCredentialIdentity,
        managedAiRuntime.sessionIdentity,
        managedAiRuntime.identity,
      );
      if (managedAiRuntime) {
        sessionConfigMetadata.aiCredentialIdentity = managedAiRuntime.sessionIdentity;
        if (!taskSessionCredentialCompatible) {
          runtimeSessionIdForAdapter = null;
          runtimeSessionParamsForAdapter = null;
          previousSessionDisplayId = null;
          delete executionContinuation?.resumeDelta;
        }
      }
      const runtimeForAdapter = {
        sessionId: runtimeSessionIdForAdapter,
        sessionParams: runtimeSessionParamsForAdapter,
        sessionDisplayId: previousSessionDisplayId,
        taskKey,
      };
      // A delta is safe only when the selected provider session is exactly the
      // task session whose last dispatch supplied the baseline history.
      if (
        executionContinuation?.resumeDelta &&
        (!taskSessionForRun ||
          !taskSession?.sessionDisplayId ||
          runtimeForAdapter.sessionDisplayId !== taskSession.sessionDisplayId ||
          resetTaskSession ||
          context.forceFreshSession === true)
      ) {
        delete executionContinuation.resumeDelta;
      }
      const configFreshnessResultMetadata = {
        version: sessionConfigMetadata.version,
        session: {
          fingerprintVersion: sessionConfigMetadata.version,
          categories: sessionConfigMetadata.categories,
          reset: resetTaskSession,
          resetReasons: sessionConfigFreshness.reasons,
          changedCategories: sessionConfigFreshness.changedCategories,
          taskSessionAvailable: taskSession != null,
          taskSessionReused: taskSessionForRun != null,
          storedFingerprintPresent: Boolean(
            sessionConfigFreshness.storedFingerprint,
          ),
          nextFingerprint: sessionConfigFreshness.nextFingerprint,
        },
        workspace: {
          fingerprintVersion: latestWorkspaceConfigMetadata.version,
          categories: latestWorkspaceConfigMetadata.categories,
          action: workspaceConfigFreshness.action,
          changedCategories: workspaceConfigFreshness.changedCategories,
          reasons: workspaceConfigFreshness.reasons,
          reuseRequested: requestedShouldReuseExisting,
          workspaceReused: Boolean(reusedExecutionWorkspace),
          configSnapshotRefreshed:
            resolvedWorkspaceReusePolicy.shouldRefreshWorkspaceConfigSnapshot,
          storedFingerprintPresent:
            workspaceConfigFreshness.storedFingerprintPresent,
          storedFingerprint: workspaceConfigFreshness.storedFingerprint,
          inferredFingerprint: workspaceConfigFreshness.inferredFingerprint,
          nextFingerprint: workspaceConfigFreshness.nextFingerprint,
          previousWorkspaceId:
            workspaceReuseRequest.requestedExecutionWorkspaceId,
          activeWorkspaceId: persistedExecutionWorkspace?.id ?? null,
        },
      };

      let handle: RunLogHandle | null = null;
      const goalCheckpointSession: {
        current: {
          params: Record<string, unknown>;
          displayId: string;
        } | null;
      } = { current: null };
      let stdoutExcerpt = "";
      let stderrExcerpt = "";
      let outputSeq = Number(run.lastOutputSeq ?? 0);
      let lastOutputFlushAt: Date | null = run.lastOutputAt ?? null;
      let lastLogRuntimeStatusTouchMs = 0;
      const outputProgressState: {
        pending: {
          at: Date;
          seq: number;
          stream: "stdout" | "stderr";
          bytes: number;
        } | null;
      } = { pending: null };
      let persistedLogBytes = Number(run.logBytes ?? 0);
      const flushOutputProgress = async (opts?: { force?: boolean }) => {
        const pendingOutputProgress = outputProgressState.pending;
        if (!pendingOutputProgress) return;
        const shouldFlush =
          opts?.force === true ||
          !lastOutputFlushAt ||
          pendingOutputProgress.at.getTime() - lastOutputFlushAt.getTime() >=
            ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS;
        if (!shouldFlush) return;
        await db
          .update(heartbeatRuns)
          .set({
            lastOutputAt: pendingOutputProgress.at,
            lastOutputSeq: pendingOutputProgress.seq,
            lastOutputStream: pendingOutputProgress.stream,
            lastOutputBytes: pendingOutputProgress.bytes,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
        lastOutputFlushAt = pendingOutputProgress.at;
        outputProgressState.pending = null;
      };
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

        handle = await runLogStore.begin({
          companyId: run.companyId,
          agentId: run.agentId,
          runId,
        });

        await db
          .update(heartbeatRuns)
          .set({
            logStore: handle.store,
            logRef: handle.logRef,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, runId));

        const currentUserRedactionOptions =
          await getCurrentUserRedactionOptions();
        const appendIdentityRedactedLog = async (stream: "stdout" | "stderr", chunk: string) => {
          const sanitizedChunk = compactRunLogChunk(
            redactCurrentUserText(chunk, currentUserRedactionOptions),
          );
          if (stream === "stdout")
            stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
          if (stream === "stderr")
            stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
          const ts = new Date().toISOString();

          outputSeq += 1;
          const chunkSeq = outputSeq;
          let appendedBytes = 0;
          if (handle) {
            appendedBytes = await runLogStore.append(handle, {
              stream,
              chunk: sanitizedChunk,
              ts,
              seq: chunkSeq,
            });
            persistedLogBytes += appendedBytes;
          }
          outputProgressState.pending = {
            at: new Date(ts),
            seq: chunkSeq,
            stream,
            bytes: persistedLogBytes,
          };
          await flushOutputProgress();

          // Streamed CLI output is real run activity: keep the in-memory
          // runtime status ("Working... / X ago") fresh between structured
          // events so sandbox runs with mid-run log streaming never show a
          // minutes-stale timestamp. Throttled to avoid churning the live
          // event stream on every 250ms tail chunk.
          const logActivityAt = new Date(ts);
          if (
            isHeartbeatRunRuntimeStatusActive(run.status) &&
            logActivityAt.getTime() - lastLogRuntimeStatusTouchMs >=
              ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS
          ) {
            lastLogRuntimeStatusTouchMs = logActivityAt.getTime();
            const touchedStatus = touchHeartbeatRunRuntimeStatus({
              companyId: run.companyId,
              issueId,
              agentId: run.agentId,
              runId: run.id,
              at: logActivityAt,
            });
            if (touchedStatus)
              publishHeartbeatRunRuntimeProgress(touchedStatus);
          }

          const payloadChunk =
            sanitizedChunk.length > MAX_LIVE_LOG_CHUNK_BYTES
              ? sanitizedChunk.slice(
                  sanitizedChunk.length - MAX_LIVE_LOG_CHUNK_BYTES,
                )
              : sanitizedChunk;

          publishLiveEvent({
            companyId: run.companyId,
            type: "heartbeat.run.log",
            payload: {
              runId: run.id,
              agentId: run.agentId,
              issueId,
              ts,
              seq: chunkSeq,
              stream,
              chunk: payloadChunk,
              truncated: payloadChunk.length !== sanitizedChunk.length,
            },
          });
        };
        const onLog = (stream: "stdout" | "stderr", chunk: string) =>
          appendIdentityRedactedLog(stream, identityRedactor.chunk(stream, chunk));
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
        await assertGitSensitiveAdapterWorkspaceValid({
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
        });
        const adapterEnv = Object.fromEntries(
          Object.entries(parseObject(runtimeConfig.env)).filter(
            (entry): entry is [string, string] =>
              typeof entry[0] === "string" && typeof entry[1] === "string",
          ),
        );
        const runtimeServices = await ensureRuntimeServicesForRun({
          db,
          runId: run.id,
          agent: {
            id: agent.id,
            name: agent.name,
            companyId: agent.companyId,
          },
          issue: issueRef,
          workspace: executionWorkspace,
          executionWorkspaceId:
            persistedExecutionWorkspace?.id ??
            issueRef?.executionWorkspaceId ??
            null,
          config: hostExecutionWorkspaceConfig,
          adapterEnv,
          onLog,
          recorder: workspaceOperationRecorder,
        });
        if (runtimeServices.length > 0) {
          context.paperclipRuntimeServices = runtimeServices;
          context.paperclipRuntimePrimaryUrl =
            runtimeServices.find((service) => readNonEmptyString(service.url))
              ?.url ?? null;
          await db
            .update(heartbeatRuns)
            .set({
              contextSnapshot: context,
              updatedAt: new Date(),
            })
            .where(eq(heartbeatRuns.id, run.id));
        }
        if (
          issueId &&
          (executionWorkspace.created ||
            runtimeServices.some((service) => !service.reused))
        ) {
          try {
            await postWorkspaceReadyComment({
              issuesSvc,
              issueId,
              agentId: agent.id,
              runId: run.id,
              workspace: executionWorkspace,
              runtimeServices,
            });
          } catch (err) {
            await onLog(
              "stderr",
              `[paperclip] Failed to post workspace-ready comment: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
          meta = identityRedactor.redact(meta);
          if (meta.env && secretKeys.size > 0) {
            for (const key of secretKeys) {
              if (key in meta.env) meta.env[key] = "***REDACTED***";
            }
          }
          await appendRunEvent(currentRun, {
            eventType: "adapter.invoke",
            stream: "system",
            level: "info",
            message: "adapter invocation",
            payload: meta as unknown as Record<string, unknown>,
          });
        };

        const onAdapterEvent = async (event: AdapterRuntimeEvent) => {
          event = identityRedactor.redact(event);
          const eventType = event.eventType.trim();
          if (!eventType) return;
          await appendRunEvent(currentRun, {
            eventType: eventType.slice(0, 120),
            stream: event.stream,
            level: event.level,
            color: event.color,
            message: event.message,
            payload: event.payload,
          });
        };

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
          dotEnabled: resolvedInstanceSettings.experimental.enableOpenAiDot === true
            && resolvedInstanceSettings.experimental.enablePublicMcp === true,
          runtimeConfig: agent.runtimeConfig,
          adapterConfig: agent.adapterConfig,
          agent: {
            id: agent.id,
            status: runningAgent.status,
            adapterType: agent.adapterType,
          },
          issue: issueRef,
          target: executionTarget,
          workspaceId: persistedExecutionWorkspace?.id ?? null,
        });
        const hasInstructionFilesystem = nativeRuntimeResolution.kind !== "native"
          ? adapter.supportsInstructionsBundle === true
          : !["claude_managed_agents_api", "aws_agentcore_harness_api", "openai_dot_mcp"].includes(nativeRuntimeResolution.profile.backend);
        if (hasInstructionFilesystem) {
          try {
            // Missing contract fields on a restored session mean the deployed
            // legacy format. New sessions opt into whole-directory persistence.
            const priorFileRun = taskSession?.lastRunId
              ? await db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(and(
                  eq(heartbeatRuns.id, taskSession.lastRunId), eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id))).then(rows => rows[0])
              : null;
            const savedFileInput = parseObject(parseObject(run.runnerProfileJson).nativeExecutionInput);
            const priorFileInput = Object.keys(savedFileInput).length ? savedFileInput : parseObject(parseObject(priorFileRun?.profile).nativeExecutionInput);
            const priorWorkingCopy = parseObject(parseObject(parseObject(priorFileInput.runtimeContext).instructions).workingCopy);
            const warmFiles = nativeRuntimeResolution.kind === "native" && (nativeRuntimeResolution.profile.backend === "codex_app_server" ||
              (nativeRuntimeResolution.profile.backend === "acpx_runtime" && parseObject(agent.adapterConfig).acpxAgent === "cursor")) &&
              (executionTarget?.kind === "remote" && executionTarget.transport === "sandbox"
                ? executionTarget.runnerLifecyclePolicy?.mode === "warm"
                : parseObject(agent.adapterConfig).lifecycleMode === "warm");
            if (warmFiles && taskSessionForRun?.lastRunId) {
              nativeInstructionReservation = await reserveWarmNativeInstructionDirectory({ companyId: agent.companyId, agentId: agent.id,
                previousRunId: taskSessionForRun.lastRunId, runId: run.id, target: executionTarget,
                canReuse: () => instructionCopies.canReuseWarm(agent.companyId, agent.id, taskSessionForRun!.lastRunId!),
              });
            }
            if (!warmFiles && nativeRuntimeResolution.kind === "native" && priorWorkingCopy.kind === "agent_files" && taskSession) {
              releaseWarmInstructionPreparation = await claimWarmNativeInstructionCopy({
                priorExecution: parseNativeExecutionInput(priorFileInput), companyId: agent.companyId, agentId: agent.id,
                executionWorkspaceId: persistedExecutionWorkspace?.id ?? run.id, workspace: executionWorkspace,
                environmentId: executionTarget?.environmentId ?? null, runId: run.id, preparationKey: instructionPreparationKey, forceRetirement: !taskSessionForRun,
                adopt: async previousRunId => {
                  instructionCopy = await instructionCopies.adopt({ companyId: agent.companyId, agentId: agent.id,
                    runId: run.id, previousRunId, target: executionTarget, cwd: executionWorkspace.cwd, allowRetirementHandoff: true });
                  return nativeInstructionWorkingCopy() ?? null;
                },
              });
              // A collection-only handoff was retired. Re-enter normal
              // preparation instead of composing a root already collected.
              if (!releaseWarmInstructionPreparation) instructionCopy = null;
            }
            const prepareInstructions = (reuseRunId?: string) => instructionCopies.prepare({
              companyId: agent.companyId, agentId: agent.id, runId: run.id,
              target: executionTarget, cwd: executionWorkspace.cwd,
              legacy: Object.keys(priorFileInput).length > 0 && priorWorkingCopy.kind !== "agent_files",
              warm: warmFiles, reuseRunId,
              onWarmHandoff: copy => {
                instructionCopy = copy;
                nativeInstructionReservation?.adopt(copy.executionRoot, collectStoppedInstructions);
              },
            });
            try {
              instructionCopy ??= await prepareInstructions(nativeInstructionReservation?.reuseRunId);
            } catch (error) {
              if (!(error instanceof AgentDirectoryReuseInvalidatedError)) throw error;
              // prepare has released its canonical lock. Retirement can now
              // collect under that same lock before a fresh restore starts.
              await nativeInstructionReservation?.release();
              nativeInstructionReservation = null;
              instructionCopy = await prepareInstructions();
            }
          } catch (error) {
            if ((error as { status?: number }).status !== 403) throw error;
            // Missing write identity must not break a background run's read-only
            // prompt. It must also never imply that ordinary file edits will save.
            await appendRunEvent(run, { eventType: "instruction_save", stream: "system", level: "warn",
              message: "Persistent instruction editing is unavailable. Use an authenticated user with instruction edit access and a managed instruction bundle.",
              payload: { state: "unavailable", code: "INSTRUCTION_COPY_UNAVAILABLE" } });
            const guidance = "No editable agent instruction working copy is registered for this turn. Use authenticated agent file tools for persistent edits; do not edit a private copy named in an earlier turn or claim its changes will persist.";
            for (const key of ["paperclipTaskMarkdown", "paperclipTaskMarkdownCompact"]) {
              context[key] = [readNonEmptyString(context[key]), guidance].filter(Boolean).join("\n\n");
            }
          }
          if (instructionCopy) {
            const storageWarning = readNonEmptyString(instructionCopy.receipt?.storageWarning);
            if (storageWarning) {
              instructionSave = { state: "prepared", contract: "agent_files", storageWarning };
              // This is an advisory on the run, never an agent pause, execution
              // failure, or scheduling gate. Keep it visible while work runs.
              await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ instructionSave })}::jsonb` }).where(eq(heartbeatRuns.id, run.id));
              await appendRunEvent(run, { eventType: "instruction_save", stream: "system", level: "warn",
                message: storageWarning, payload: instructionSave });
            }
            runtimeConfig = { ...runtimeConfig, instructionsFilePath: path.join(instructionCopy.localRoot, instructionCopy.entryFile) };
            if (isAgentDirectoryCopy(instructionCopy)) {
              const workspace = parseObject(context.paperclipWorkspace);
              context.paperclipWorkspace = { ...workspace, agentHome: instructionCopy.executionRoot,
                // Keep the pre-existing permission root stable for ACP session
                // identity. The per-run copy is already under the company root.
                agentHomeForPermissions: workspace.agentHome,
              };
            }
            const guidance = instructionWorkingCopyGuidance(instructionCopy);
            for (const key of ["paperclipTaskMarkdown", "paperclipTaskMarkdownCompact"]) {
              context[key] = [readNonEmptyString(context[key]), guidance].filter(Boolean).join("\n\n");
            }
          }
        }
        const runtimeSelection = await selectHeartbeatRuntime(db, {
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
          },
          config: {
            runtimeConfig,
            runtimeSkillEntries,
            runScopedMentionedSkillKeys,
            instructionCopy,
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
        });
        if (!runtimeSelection.selected) return;
        const { nativeExecution, nativeRunnerInstanceId, getNativeFreshSessionHandoff } = runtimeSelection;
        nativeWorkspaceSync = runtimeSelection.nativeWorkspaceSync;
        const localAgentJwtScope =
          issueRef?.workMode === "skill_test"
            ? { kind: "skill_test" as const, issueId: issueRef.id }
            : { kind: "standard" as const };
        const authToken =
          nativeRuntimeResolution.kind === "legacy" &&
          adapter.supportsLocalAgentJwt
            ? createLocalAgentJwt(
                agent.id,
                agent.companyId,
                agent.adapterType,
                run.id,
                run.responsibleUserId,
                localAgentJwtScope,
              )
            : null;
        if (
          nativeRuntimeResolution.kind === "legacy" &&
          adapter.supportsLocalAgentJwt &&
          !authToken
        ) {
          logger.warn(
            {
              companyId: agent.companyId,
              agentId: agent.id,
              runId: run.id,
              adapterType: agent.adapterType,
            },
            "local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY",
          );
        }
        let adapterFinalizeOutcome: "succeeded" | "failed" | null = null;
        const inspectFinalizeWorkspaceBranch = async () => {
          const workspaceRecord = persistedExecutionWorkspace?.id
            ? await executionWorkspacesSvc.getById(
                persistedExecutionWorkspace.id,
              )
            : persistedExecutionWorkspace;
          if (workspaceRecord?.strategyType !== "git_worktree") return null;

          const worktreePath =
            readNonEmptyString(workspaceRecord.providerRef) ??
            readNonEmptyString(workspaceRecord.cwd) ??
            readNonEmptyString(executionWorkspace.worktreePath) ??
            readNonEmptyString(executionWorkspace.cwd);
          const expectedBranchName =
            readNonEmptyString(workspaceRecord.branchName) ??
            readNonEmptyString(executionWorkspace.branchName);
          if (!worktreePath || !expectedBranchName) return null;

          const inspection = await inspectManagedGitWorktreeBranch({
            worktreePath,
            expectedBranchName,
          });
          return { workspaceRecord, inspection };
        };
        const recordWorkspaceFinalize = async (
          status: "succeeded" | "failed",
          metadata?: Record<string, unknown>,
        ) => {
          if (adapterFinalizeOutcome) return;
          let finalizeBranchMetadata: Record<string, unknown> | null = null;
          let finalizeBranchRepairMetadata: Record<string, unknown> | null =
            null;
          if (status === "succeeded") {
            const branchInspection = await inspectFinalizeWorkspaceBranch();
            if (branchInspection) {
              let inspection = branchInspection.inspection;
              const initialManagedGitWorktreeBranch =
                formatManagedGitWorktreeBranchInspection(inspection);
              if (
                !inspection.valid &&
                inspection.reasonCode === "branch_mismatch" &&
                inspection.repoRoot
              ) {
                let repairedExpectedBranchName = inspection.expectedBranchName;
                try {
                  const coherence = await ensureGitWorktreeBranchCoherent({
                    db,
                    repoRoot: inspection.repoRoot,
                    worktreePath: inspection.worktreePath,
                    expectedBranchName: inspection.expectedBranchName,
                    actualBranchName: inspection.actualBranchName,
                    sourceIssue: issueRef
                      ? {
                          id: issueRef.id,
                          identifier: issueRef.identifier,
                          title: issueRef.title,
                          workMode: issueRef.workMode,
                        }
                      : null,
                    executionWorkspaceId: branchInspection.workspaceRecord.id,
                    heartbeatRunId: run.id,
                    enableWorkspaceBranchReconcileForward:
                      resolvedInstanceSettings.experimental
                        .enableWorkspaceBranchReconcileForward,
                    enableWorkspaceDirtyQuarantineRepair:
                      resolvedInstanceSettings.experimental
                        .enableWorkspaceDirtyQuarantineRepair,
                    persistForwardReconcile: false,
                    reconcileOperationPhase: "workspace_finalize",
                    recorder: workspaceOperationRecorder,
                  });
                  if (
                    coherence.branchName &&
                    coherence.branchName !==
                      branchInspection.workspaceRecord.branchName
                  ) {
                    repairedExpectedBranchName = coherence.branchName;
                    executionWorkspace.branchName = coherence.branchName;
                    executionWorkspace.warnings.push(...coherence.warnings);
                  }
                } catch (repairErr) {
                  const workspaceValidationFailure =
                    isWorkspaceValidationFailure(repairErr) ? repairErr : null;
                  finalizeBranchMetadata = {
                    executionWorkspaceId: branchInspection.workspaceRecord.id,
                    ...initialManagedGitWorktreeBranch,
                  };
                  finalizeBranchRepairMetadata = {
                    attempted: true,
                    succeeded: false,
                    initial: initialManagedGitWorktreeBranch,
                    reason:
                      repairErr instanceof Error
                        ? repairErr.message
                        : String(repairErr),
                  };
                  await workspaceOperationRecorder.recordOperation({
                    phase: "workspace_finalize",
                    cwd: executionWorkspace.cwd,
                    metadata: {
                      adapterType: agent.adapterType,
                      executionTargetKind: executionTarget?.kind ?? "local",
                      ...metadata,
                      managedGitWorktreeBranch: finalizeBranchMetadata,
                      managedGitWorktreeBranchRepair:
                        finalizeBranchRepairMetadata,
                      ...(workspaceValidationFailure?.resultJson
                        ? {
                            workspaceValidation:
                              workspaceValidationFailure.resultJson
                                .workspaceValidation ??
                              workspaceValidationFailure.resultJson,
                          }
                        : {}),
                    },
                    run: async () => ({
                      status: "failed",
                      stderr: `Managed git worktree branch check failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}\n`,
                    }),
                  });
                  adapterFinalizeOutcome = "failed";
                  throw repairErr;
                }

                const repairedInspection =
                  await inspectManagedGitWorktreeBranch({
                    worktreePath: inspection.worktreePath,
                    expectedBranchName: repairedExpectedBranchName,
                    repoRoot: inspection.repoRoot,
                  });
                finalizeBranchRepairMetadata = {
                  attempted: true,
                  succeeded: repairedInspection.valid,
                  initial: initialManagedGitWorktreeBranch,
                  repaired:
                    formatManagedGitWorktreeBranchInspection(
                      repairedInspection,
                    ),
                };
                inspection = repairedInspection;
              }

              const managedGitWorktreeBranch =
                formatManagedGitWorktreeBranchInspection(inspection);
              finalizeBranchMetadata = {
                executionWorkspaceId: branchInspection.workspaceRecord.id,
                ...managedGitWorktreeBranch,
              };
              if (!inspection.valid) {
                const workspaceValidationFingerprint =
                  fingerprintFinalizeWorkspaceBranchValidation({
                    issueId: issueRef?.id ?? null,
                    executionWorkspaceId: branchInspection.workspaceRecord.id,
                    inspection: managedGitWorktreeBranch,
                  });
                await workspaceOperationRecorder.recordOperation({
                  phase: "workspace_finalize",
                  cwd: executionWorkspace.cwd,
                  metadata: {
                    adapterType: agent.adapterType,
                    executionTargetKind: executionTarget?.kind ?? "local",
                    ...metadata,
                    managedGitWorktreeBranch: finalizeBranchMetadata,
                    ...(finalizeBranchRepairMetadata
                      ? {
                          managedGitWorktreeBranchRepair:
                            finalizeBranchRepairMetadata,
                        }
                      : {}),
                  },
                  run: async () => ({
                    status: "failed",
                    stderr: `Managed git worktree branch check failed: ${inspection.reason ?? "unknown branch mismatch"}\n`,
                  }),
                });
                adapterFinalizeOutcome = "failed";
                throw new WorkspaceValidationFailure(
                  `Execution workspace ${branchInspection.workspaceRecord.id} expected git worktree branch "${inspection.expectedBranchName}" at "${inspection.worktreePath}", but ${inspection.reason ?? "the checked-out branch could not be verified"}. Record a sanctioned execution-workspace branch transition or restore the workspace branch before completing the run.`,
                  {
                    workspaceValidation: {
                      reason: "git_worktree_branch_incoherence",
                      fingerprint: workspaceValidationFingerprint,
                      adapterType: agent.adapterType,
                      issueId: issueRef?.id ?? null,
                      issueIdentifier: issueRef?.identifier ?? null,
                      persistedExecutionWorkspaceId:
                        branchInspection.workspaceRecord.id,
                      executionWorkspaceCwd: executionWorkspace.cwd,
                      managedGitWorktreeBranch: finalizeBranchMetadata,
                    },
                  },
                );
              }
            }
          }
          await workspaceOperationRecorder.recordOperation({
            phase: "workspace_finalize",
            cwd: executionWorkspace.cwd,
            metadata: {
              adapterType: agent.adapterType,
              executionTargetKind: executionTarget?.kind ?? "local",
              ...metadata,
              ...(finalizeBranchMetadata
                ? { managedGitWorktreeBranch: finalizeBranchMetadata }
                : {}),
              ...(finalizeBranchRepairMetadata
                ? {
                    managedGitWorktreeBranchRepair:
                      finalizeBranchRepairMetadata,
                  }
                : {}),
            },
            run: async () => ({ status }),
          });
          // Only mark the outcome after the row landed, so a transient write
          // failure on the succeeded path can still be recovered by recording
          // finalize=failed from the catch path below.
          adapterFinalizeOutcome = status;
        };

        const usageRecorder = await createRunUsageRecorder(db, { companyId: run.companyId, runId: run.id, adapterType: agent.adapterType });
        persistUsageCaptureFailure = usageRecorder.persistFailure;
        let adapterResult: AdapterExecutionResult;
        const runGoalControlRequestId = readNonEmptyString(
          context.goalControlRequestId,
        );
        try {
          if (nativeRuntimeResolution.kind === "native") {
            if (!nativeExecution || !nativeRunnerInstanceId)
              throw new Error("native_runtime_selection_not_persisted");
            const expectedNativeMcpDigest =
              "runtimeContext" in nativeExecution &&
              nativeExecution.runtimeContext.mcp.bindingId
                ? nativeExecution.runtimeContext.mcp.digest
                : null;
            const nativeMcpServers = await buildPaperclipRuntimeMcpServers({
              db,
              agent,
              runId: run.id,
              expectedAssignmentDigest: expectedNativeMcpDigest,
            });
            if ("runtimeContext" in nativeExecution) {
              if (nativeMcpServers.length > 1)
                throw new Error(
                  "native MCP realization must produce one aggregate gateway",
                );
              const server = nativeMcpServers[0] ?? null;
              const digest = server?.connectionId.startsWith("assignment:")
                ? server.connectionId.slice("assignment:".length)
                : null;
              if (digest && digest !== expectedNativeMcpDigest) {
                throw new Error("native MCP assignment digest mismatch");
              }
            }
            const nativeMcpServer = nativeMcpServers[0] ?? null;
            let sessionGoalControl = parseNativeSessionGoalControl(
              context.runnerGoalControl,
            );
            if (runGoalControlRequestId && !sessionGoalControl) {
              throw new Error("session_goal_control_payload_invalid");
            }
            // A hard restart replays the heartbeat context, not a new user
            // action. Do not repeat a completed create/replace/edit (which
            // could reactivate or clear a goal that finished while detached).
            const completedGoalControl =
              sessionGoalControl !== null &&
              taskKey !== null &&
              (await isRunnerGoalActionCompleted(
                db,
                {
                  companyId: agent.companyId,
                  agentId: agent.id,
                  issueId: taskKey,
                },
                sessionGoalControl.requestId,
              ));
            if (completedGoalControl) sessionGoalControl = null;
            const nativeDispatchAtMs = Date.now();
            const runCreatedAtMs = run.createdAt.getTime();
            const runStartedAtMs = (run.startedAt ?? run.createdAt).getTime();
            const wakeComments = Array.isArray(
              parseObject(context.paperclipWake).comments,
            )
              ? (parseObject(context.paperclipWake).comments as unknown[])
              : [];
            const wakeIngressSpan = buildNativeWakeIngressSpan({
              runCreatedAtMs,
              wakeComments,
              attestedQuestionResponseAtMs,
            });
            if (wakeIngressSpan)
              nativeRunnerPreparationSpans.unshift(wakeIngressSpan);
            nativeRunnerPreparationSpans.push(
              ...buildNativeHeartbeatPreparationSpans({
                runCreatedAtMs,
                runStartedAtMs,
                attemptStartedAtMs,
                environmentAcquireStartedAtMs,
                environmentRealizeEndedAtMs,
                nativeDispatchAtMs,
              }),
            );
            const guardedDispatch =
              await dispatchResolvedInteractionContinuationWithAtomicGate(
                (markDispatchStarted) => {
                  return executePaperclipNativeSession({
                    db,
                    execution: nativeExecution,
                    getFreshSessionHandoff: getNativeFreshSessionHandoff,
                    refreshTools: context.refreshTools === true,
                    conversationMode: isConversation(issueContext),
                    turnTimeoutMs: Math.max(0, asNumber(runtimeConfig.timeoutSec, 0)) * 1_000,
                    runnerInstanceId: nativeRunnerInstanceId,
                    leaseOwner: runOptions.nativeLeaseOwner,
                    restartRecovery: runOptions.nativeRestartRecovery,
                    backend:
                      options.nativeSessionBackendFactory?.(nativeExecution),
                    useRunnerd: agent.adapterType === "paperclip_runner",
                    adapterType: agent.adapterType,
                    sessionGoalControl,
                    resumeSessionGoalHeartbeat:
                      context.resumeSessionGoalHeartbeat === true ||
                      completedGoalControl,
                    onGoalCheckpoint: async (snapshot) => {
                      if (!taskKey) return;
                      const params =
                        attachPaperclipSessionMetadataToSessionParams(
                          {
                            ...runtimeSessionParamsForAdapter,
                            sessionId: snapshot.identity.sessionId,
                            cwd: executionWorkspace.cwd,
                          },
                          configuredModel,
                          sessionConfigMetadata,
                        )!;
                      const displayId =
                        snapshot.providerSessionId ?? snapshot.sessionId;
                      await upsertTaskSession({
                        companyId: agent.companyId,
                        agentId: agent.id,
                        adapterType: agent.adapterType,
                        taskKey,
                        sessionParamsJson: params,
                        sessionDisplayId: displayId,
                        lastRunId: run.id,
                        lastError: null,
                      });
                      goalCheckpointSession.current = { params, displayId };
                    },
                    onLog,
                    onEvent: onAdapterEvent,
                    instructionWorkingCopy: nativeInstructionWorkingCopy(),

                    onUsage: async receipt => { await usageRecorder.capture(receipt); },
                    preparationSpans: nativeRunnerPreparationSpans,
                    // Bootstrap with executable/home discovery while keeping
                    // configured provider values and the server-selected
                    // workspace boundary authoritative.
                    managedGitHub: !useHostGitHub && githubSelection.configured,
                    billingIdentity: managedAiRuntime ? { provider: managedAiRuntime.attribution.provider, biller: managedAiRuntime.attribution.provider === "openai" ? resolveManagedOpenAiBilling(managedAiRuntime.config.managedAiRouting)?.biller ?? managedAiRuntime.attribution.provider : managedAiRuntime.attribution.provider, billingType: managedAiRuntime.attribution.method === "subscription" ? "subscription_included" : "metered_api" } : undefined,
                    managedAiCredentialIdentity: managedAiRuntime?.identity,
                    managedAiCredentialHome: managedAiRuntime ? String((managedAiRuntime.config.env as Record<string, unknown>).CODEX_HOME) : undefined,
                    dotWorkspaceRoot: nativeExecution.provider.kind === "openai_dot" && resolvedConfig.dotWorkspaceAccess === true ? executionWorkspace.cwd : undefined,
                    runnerEnvironment: {
                      ...configuredEnvironmentProjection(configuredTaskEnvironment),
                      ...buildNativeProviderEnvironment(
                        adapterEnv,
                        process.env,
                        executionWorkspace.cwd,
                      ),
                      ...buildAgentIdentityEnv(agentIdentity),
                      ...(instructionCopy && isAgentDirectoryCopy(instructionCopy) ? { AGENT_HOME: instructionCopy.executionRoot } : {}),
                      ...(nativeMcpServer
                        ? {
                            PAPERCLIP_NATIVE_MCP_NAME: nativeMcpServer.name,
                            PAPERCLIP_NATIVE_MCP_URL: nativeMcpServer.url,
                            PAPERCLIP_NATIVE_MCP_TOKEN: nativeMcpServer.token,
                          }
                        : {}),
                      ...(providerTraceCapture
                        ? {
                            PAPERCLIP_PROVIDER_TRACE_PATH:
                              providerTraceCapture.path,
                            PAPERCLIP_PROVIDER_TRACE_MAX_BYTES: String(
                              PROVIDER_TRACE_MAX_BYTES,
                            ),
                          }
                        : {}),
                    },
                    runnerExecutionTarget: executionTarget,
                    runnerIngressAuthorized: isRunnerIngressAuthorized(
                      nativeRuntimeResolution,
                    ),
                    runnerPublicUrl:
                      runtimeEnv.PAPERCLIP_RUNNER_PUBLIC_URL?.trim() || null,
                    runnerCaBundlePath:
                      runtimeEnv.PAPERCLIP_RUNNER_CA_BUNDLE_PATH?.trim() ||
                      null,
                    runnerRemoteBinaryPath:
                      runtimeEnv.PAPERCLIP_RUNNER_REMOTE_BINARY_PATH?.trim() ||
                      null,
                    runnerRemoteCodexPath:
                      runtimeEnv.PAPERCLIP_RUNNER_REMOTE_CODEX_PATH?.trim() ||
                      null,
                    runnerRemoteCodexNpmSpec:
                      runtimeEnv.PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC?.trim() ||
                      null,
                    runnerRemoteProviderPackPath:
                      runtimeEnv.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH?.trim() ||
                      null,
                    stopTaskForReassignment: async (target) => {
                      await settleLiveRunnerGoalBeforeInterrupt(db, target);
                      if (!target.runId) return;
                      const prior = await getRun(target.runId);
                      if (!prior || prior.companyId !== target.companyId || prior.agentId !== target.agentId) {
                        throw conflict("Reassignment run binding changed");
                      }
                      const stopped = await cancelRunInternal(target.runId, "Cancelled for task reassignment", {
                        errorCode: "issue_reassigned", suppressImmediateRecovery: true,
                        resultJson: { reassignmentStopConfirmed: true },
                      });
                      if (stopped && ["running", "queued", "scheduled_retry"].includes(stopped.status)) {
                        throw conflict("The previous run did not stop; reassignment was not applied");
                      }
                    },
                    enqueueWakeup,
                    syncIssueExternalObjects: externalObjectService(db, {
                      pluginWorkerManager: options.pluginWorkerManager,
                      enabled: async () => (await instanceSettings.getExperimental()).enableExternalObjects === true,
                    }).syncIssueSafely,
                    onSpawn: async (meta) => {
                      markDispatchStarted();
                      await persistRunProcessMetadata(run.id, { ...meta, targetKind: executionTarget?.kind ?? "local" });
                    },
                  });
                },
              );
            if (!guardedDispatch.dispatched) return;
            nativeDispatchStarted = true;
            adapterResult = await guardedDispatch.resultPromise;
          } else {
            const interactionId = readNonEmptyString(context.interactionId);
            const legacyQuestionResponse =
              issueRef &&
              interactionId &&
              readNonEmptyString(context.interactionKind) ===
                "ask_user_questions" &&
              readNonEmptyString(context.interactionStatus) === "answered"
                ? await materializeLegacyQuestionResponseWakeProjection({
                    db,
                    companyId: agent.companyId,
                    issueId: issueRef.id,
                    runId: run.id,
                    agentId: agent.id,
                    interactionId,
                  })
                : null;
            // Do not write the answer projection back to `context`: legacy
            // adapters need it in their prompt, but the authoritative answers
            // remain on the interaction instead of being duplicated in the
            // heartbeat run snapshot.
            const adapterContext: Record<string, unknown> = {
              ...context,
              ...(legacyQuestionResponse
                ? {
                    [PAPERCLIP_WAKE_PAYLOAD_KEY]: {
                      ...parseObject(context[PAPERCLIP_WAKE_PAYLOAD_KEY]),
                      questionResponse: legacyQuestionResponse,
                    },
                  }
                : {}),
            };
            const runtimeTools = createAdapterRuntimeToolAccess({
              agentId: agent.id,
              companyId: agent.companyId,
              runId: run.id,
              responsibleUserId: run.responsibleUserId,
            });
            if (!runtimeTools) {
              logger.warn(
                {
                  companyId: agent.companyId,
                  agentId: agent.id,
                  runId: run.id,
                },
                "runtime connection tools could not be delivered",
              );
            }
            const runtimeMcpServers = await buildPaperclipRuntimeMcpServers({
              db,
              agent,
              runId: run.id,
            });
            const runtimeToolDelivery =
              adapter.runtimeToolDelivery ?? "invocation_context";
            if (runtimeTools && runtimeToolDelivery === "native_mcp") {
              runtimeMcpServers.unshift({
                name: "Paperclip connections",
                url: runtimeTools.mcpEndpoint,
                token: runtimeTools.bearerToken,
                connectionId: "paperclip-runtime-tools",
              });
            }
            if (authToken && configuredPaperclipApiBaseUrl() && issueRef) {
              runtimeMcpServers.unshift({ name: "Paperclip projects", url: `${paperclipApiBaseUrl()}/api/mcp/project-tools`,
                token: authToken, connectionId: "paperclip-project-tools" });
            }
            const runtimeMcp = createAdapterRuntimeMcpAccess(runtimeMcpServers);
            if (runtimeTools && runtimeToolDelivery === "invocation_context") {
              adapterContext.paperclipRuntimeTools = runtimeTools;
            }
            const managedMcpConfig = await createManagedMcpRunConfig({
              db,
              agent,
              runId: run.id,
              config: runtimeConfig,
              projectId: issueRef?.projectId ?? null,
              issueId: issueRef?.id ?? null,
            });
            if (managedMcpConfig) {
              adapterContext.paperclipManagedMcp = managedMcpConfig;
            }
            const guardedDispatch =
              await dispatchResolvedInteractionContinuationWithAtomicGate(
                (markDispatchStarted) => {
                  legacyAdapterEntered = true;
                  return withAdapterExecutionPhase(executionPhaseContext, "adapter_execution", () => adapter.execute({
                    getFreshSessionHandoff,
                    agentIdentity,
                    runId: run.id,
                    agent,
                    runtime: runtimeForAdapter,
                    config: runtimeConfig,
                    context: adapterContext,
                    executionContinuation: executionContinuation ?? null,
                    runtimeCommandSpec:
                      adapter.getRuntimeCommandSpec?.(runtimeConfig) ?? null,
                    executionTarget,
                    executionTransport: remoteExecution
                      ? {
                          remoteExecution: remoteExecution as unknown as Record<
                            string,
                            unknown
                          >,
                        }
                      : undefined,
                    runtimeMcp,
                    runtimeTools,
                    onLog,
                    onMeta: onAdapterMeta,
                    onEvent: onAdapterEvent,
                    onUsage: async receipt => { await usageRecorder.capture(receipt); },
                    onExecutionPhase: executionControl.phases.enter,
                    startupTraceContext: getStartupTraceContext(),
                    onRuntimeProgress: async (progress) => {
                      await recordCurrentHeartbeatRunRuntimeProgress(
                        run,
                        progress,
                        issueId,
                      );
                    },
                    onProviderStopped: collectStoppedInstructions,
                    onDispatch: markDispatchStarted,
                    signal: executionControl.controller.signal,
                    ...(executionTarget?.kind === "remote" && executionTarget.transport === "sandbox" ? {
                      stopRemoteStartup: async () => {
                        // Scope comes from the running host invocation, never agent
                        // config. Keep adapter ownership until setup has unwound.
                        if (!executionControl.controller.signal.aborted) {
                          throw new Error("Remote startup stop requires a cancelled run");
                        }
                        const release = await envOrchestrator.releaseForRun({
                          heartbeatRunId: run.id,
                          companyId: agent.companyId,
                          agentId: agent.id,
                          status: "released",
                          providerResourceDisposition: "stop_and_retain",
                          cancelActiveWork: true,
                        });
                        if (release.errors.length || !await remoteExecutionHasStopped(db, agent.companyId, run.id)) {
                          throw new Error("Could not verify remote startup stopped");
                        }
                      },
                    } : {}),
                    onCancellationReady: async () => {
                      await registerAdapterExecutionControl(run.id, executionControl);
                      const current = await getRun(run.id);
                      if (!current || isHeartbeatRunTerminalStatus(current.status)) {
                        executionControl.controller.abort(new Error("Run stopped before provider startup"));
                      }
                    },
                    onSpawn: async (meta) => {
                      markDispatchStarted();
                      await persistRunProcessMetadata(run.id, {
                        pid: meta.pid,
                        processGroupId:
                          "processGroupId" in meta &&
                          typeof meta.processGroupId === "number"
                            ? meta.processGroupId
                            : null,
                        startedAt: meta.startedAt,
                      });
                    },
                    authToken: authToken ?? undefined,
                  }));
                },
              );
            if (!guardedDispatch.dispatched) return;
            adapterResult = await guardedDispatch.resultPromise;
          }
          adapterResult = identityRedactor.redact(adapterResult);
          if (run.runtimeMode === "legacy" && hasWorkspaceRestoreFailure(adapterResult.resultJson)
              && executionTarget?.kind === "remote" && executionTarget.transport === "sandbox") {
            requiredWorkspaceRestoreEvidence = {
              workspaceRestoreFailure: adapterResult.resultJson!.workspaceRestoreFailure,
              ...(adapterResult.resultJson?.workspaceRestoreDiagnostic ? { workspaceRestoreDiagnostic: adapterResult.resultJson.workspaceRestoreDiagnostic } : {}),
            };
            // Retention is the fallback even if recording this receipt fails.
            providerResourceDispositionForRun = "stop_and_retain";
            await recordLegacyWorkspaceRestoreFailure(db, run, requiredWorkspaceRestoreEvidence);
          }
          for (const stream of ["stdout", "stderr"] as const) {
            const tail = identityRedactor.finish(stream);
            if (tail) await appendIdentityRedactedLog(stream, tail);
          }
          if (instructionSave) adapterResult.resultJson = { ...adapterResult.resultJson, instructionSave };

          if (parseObject(adapterResult.executionRecovery).providerWorkStarted !== false) {
            const captured = await usageRecorder.complete(adapterResult);
            adapterResult = { ...adapterResult, ...captured, usageComplete: captured.complete };
          } else {
            // Stop may already own the terminal result. Preserve its metadata
            // while durably recording the proof needed to release admission.
            await db.update(heartbeatRuns).set({ costAccountingPending: true,
              usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) || '{"accountingProviderWorkStarted":false}'::jsonb`,
            }).where(and(eq(heartbeatRuns.id, run.id), isNull(heartbeatRuns.costAccountedAt)));
          }
          adapterResult = applyWorkspaceRestoreFailure(adapterResult);
          // A returned result can include a failed restore. Keep the workspace
          // barrier closed until required files have been restored.
          // If recording the barrier itself fails, propagate as a run failure
          // rather than silently leaving dependents stranded behind a missing
          // finalize row.
          const completeWorkspace = async (ownership?: NativeWorkspaceFinalizationOwnership) => {
            try {
              if (nativeWorkspaceSync) {
                const exported = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
                  eq(workspaceOperations.companyId, run.companyId),
                  eq(workspaceOperations.heartbeatRunId, run.id),
                  eq(workspaceOperations.phase, "workspace_finalize"),
                  eq(workspaceOperations.status, "succeeded"),
                )).limit(1);
                if (exported.length) adapterFinalizeOutcome = "succeeded";
                else await restoreNativeWorkspaceBestEffort({
                  db, runId: run.id, assertOwnership: ownership?.assertHeld,
                  restore: () => nativeWorkspaceSync!.restoreWorkspace(ownership?.assertHeld),
                });
              }
              await ownership?.assertHeld();
              await db
                .update(heartbeatRuns)
                .set({ executionControlDeadlineAt: new Date(Date.now() + 60_000) })
                .where(
                  and(
                    eq(heartbeatRuns.id, run.id),
                    eq(heartbeatRuns.status, "running"),
                  ),
                );
              const workspaceFinalizeStatus = hasWorkspaceRestoreFailure(adapterResult.resultJson) ? "failed" : "succeeded";
              await recordWorkspaceFinalize(workspaceFinalizeStatus);
              if (adapterResult.nativeFinalization) {
                adapterResult.nativeFinalization.workspaceFinalizeStatus =
                  workspaceFinalizeStatus;
                try {
                  const finalized = await finalizeNativeRun({
                    db,
                    runId: run.id,
                    workspaceFinalizeStatus,
                    preserveProviderAttempt: Boolean(nativeWorkspaceSync),
                  });
                  await dispatchPendingNativeStatusWakeups({
                    companyId: run.companyId,
                  });
                  if (finalized.phase === "committed") {
                    await nativeWorkspaceSync?.cleanup();
                  }
                } catch (finalizeErr) {
                  logger.warn(
                    { err: finalizeErr, runId: run.id },
                    "native result persisted but finalization did not apply; the reconciliation loop will retry",
                  );
                }
              }
            } catch (error) {
              if (ownership) {
                await ownership.assertHeld();
                await recordWorkspaceFinalize("failed");
              }
              throw error;
            }
          };
          if (nativeWorkspaceSync) {
            const owned = await withNativeWorkspaceFinalizationOwnership({
              db, companyId: run.companyId, runId: run.id,
            }, completeWorkspace);
            if (!owned.acquired) throw new NativeWorkspaceFinalizationBusyError();
          } else {
            await completeWorkspace();
          }
        } catch (adapterErr) {
          if (adapterErr instanceof NativeCancellationPendingRecoveryError) {
            // Durable cancellation is settled by the outer recovery handler;
            // it does not imply a failed workspace or a persisted run result.
            throw adapterErr;
          }
          if (adapterErr instanceof NativeWorkspaceFinalizationBusyError
            || adapterErr instanceof NativeWorkspaceFinalizationOwnershipLostError) {
            nativeWorkspaceFinalizeScheduled = true;
            throw adapterErr;
          }
          if (adapterErr instanceof NativeControllerDetachedForRestartError) {
            // Preserve the provider and its run for the new controller. This
            // also keeps generic teardown from terminalizing/releasing its lease.
            nativeSessionResumeScheduled = true;
            throw adapterErr;
          }
          if (adapterErr instanceof NativeRunnerOwnershipUnverifiedError) {
            nativeOwnershipHeld = true;
            throw adapterErr;
          }
          await db
            .update(heartbeatRuns)
            .set({ executionControlDeadlineAt: new Date(Date.now() + 60_000) })
            .where(
              and(
                eq(heartbeatRuns.id, run.id),
                eq(heartbeatRuns.status, "running"),
              ),
            );
          if (
            issueRef &&
            context.resumeSessionGoalHeartbeat === true &&
            !runGoalControlRequestId
          ) {
            await blockRunnerGoalRecovery(
              db,
              {
                companyId: run.companyId,
                issueId: issueRef.id,
                agentId: agent.id,
                adapterType: agent.adapterType,
              },
              "provider_session_goal_recovery_failed",
            ).catch(() => undefined);
          }
          if (issueRef && runGoalControlRequestId) {
            await failRunnerGoalAction(
              db,
              {
                companyId: run.companyId,
                issueId: issueRef.id,
                agentId: agent.id,
                adapterType: agent.adapterType,
              },
              runGoalControlRequestId,
              adapterErr instanceof Error
                ? adapterErr.message
                : "session_goal_control_failed",
            ).catch(() => undefined);
          }
          const nativeResumeScheduled =
            nativeRuntimeResolution.kind === "native"
              ? await db
                  .select({
                    phase: nativeRunFinalizations.phase,
                    resultId: nativeRunFinalizations.resultId,
                  })
                  .from(nativeRunFinalizations)
                  .where(eq(nativeRunFinalizations.runId, run.id))
                  .limit(1)
                  .then(
                    (rows) =>
                      rows[0]?.phase === "retryable_failure" &&
                      rows[0]?.resultId === null,
                  )
              : false;
          if (nativeResumeScheduled) {
            nativeSessionResumeScheduled = true;
            throw new NativeSessionResumeScheduledError(adapterErr);
          }
          // Adapter (or its restore finally) threw — or the finalize record
          // write itself threw. Either way the workspace may be in a partial
          // state. Best-effort record finalize=failed so the dependent readiness
          // check keeps the gate closed instead of waking on stale local state,
          // and surface the original error to the caller.
          try {
            await recordWorkspaceFinalize("failed", {
              errorMessage:
                adapterErr instanceof Error
                  ? adapterErr.message
                  : String(adapterErr),
            });
          } catch (recordErr) {
            logger.warn(
              {
                err: recordErr,
                runId: run.id,
                executionWorkspaceId: persistedExecutionWorkspace?.id ?? null,
              },
              "failed to record workspace_finalize=failed operation; dependents may remain gated",
            );
          }
          if (nativeRuntimeResolution.kind === "native") {
            const proposedResult = await db
              .select({ resultId: nativeRunFinalizations.resultId })
              .from(nativeRunFinalizations)
              .where(eq(nativeRunFinalizations.runId, run.id))
              .limit(1)
              .then((rows) => rows[0]?.resultId ?? null);
            if (proposedResult && nativeWorkspaceSync) {
              const workspaceFailureMessage =
                adapterErr instanceof Error ? adapterErr.message : "";
              const unrecoverable =
                workspaceFailureMessage ===
                  "workspace_sync_out_unrecoverable" ||
                workspaceFailureMessage.includes("daytona_sandbox_not_found");
              const failure = await recordNativeFinalizationFailure({
                db,
                runId: run.id,
                error: new Error(
                  unrecoverable
                    ? "native_workspace_sync_out_unrecoverable"
                    : "native_workspace_sync_out_failed",
                ),
                projectRunStatus: true,
                failureScope: "workspace",
                permanent: unrecoverable,
              });
              nativeWorkspaceFinalizeScheduled = true;
              throw new NativeWorkspaceFinalizeScheduledError(
                adapterErr,
                failure.phase === "terminal_failure",
                unrecoverable
                  ? "workspace_sync_out_unrecoverable"
                  : "workspace_sync_out_failed",
              );
            }
            try {
              await finalizeNativeRun({
                db,
                runId: run.id,
                workspaceFinalizeStatus: "failed",
              });
              await dispatchPendingNativeStatusWakeups({
                companyId: run.companyId,
              });
            } catch (finalizeErr) {
              logger.warn(
                { err: finalizeErr, runId: run.id },
                "native result could not be marked workspace_failed; the reconciliation loop will retry persisted results",
              );
            }
          }
          throw adapterErr;
        } finally {
          try {
            await revokeHeartbeatRunGatewayTokens({
              db,
              companyId: agent.companyId,
              runId: run.id,
            });
          } catch (revokeErr) {
            logger.warn(
              { err: revokeErr, runId: run.id, companyId: agent.companyId },
              "failed to revoke heartbeat-run MCP gateway tokens",
            );
          }
          await nativeInstructionReservation?.release();
          await withAdapterExecutionPhase(executionPhaseContext, "instruction_cleanup", releaseInstructionCopy);
        }
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
        const adapterManagedRuntimeServices = adapterResult.runtimeServices
          ? await persistAdapterManagedRuntimeServices({
              db,
              adapterType: agent.adapterType,
              runId: run.id,
              agent: {
                id: agent.id,
                name: agent.name,
                companyId: agent.companyId,
              },
              issue: issueRef,
              workspace: executionWorkspace,
              reports: adapterResult.runtimeServices,
            })
          : [];
        if (adapterManagedRuntimeServices.length > 0) {
          const combinedRuntimeServices = [
            ...runtimeServices,
            ...adapterManagedRuntimeServices,
          ];
          context.paperclipRuntimeServices = combinedRuntimeServices;
          context.paperclipRuntimePrimaryUrl =
            combinedRuntimeServices.find((service) =>
              readNonEmptyString(service.url),
            )?.url ?? null;
          await db
            .update(heartbeatRuns)
            .set({
              contextSnapshot: context,
              updatedAt: new Date(),
            })
            .where(eq(heartbeatRuns.id, run.id));
          if (issueId) {
            try {
              await postWorkspaceReadyComment({
                issuesSvc,
                issueId,
                agentId: agent.id,
                runId: run.id,
                workspace: executionWorkspace,
                runtimeServices: adapterManagedRuntimeServices,
              });
            } catch (err) {
              await onLog(
                "stderr",
                `[paperclip] Failed to post adapter-managed runtime comment: ${err instanceof Error ? err.message : String(err)}\n`,
              );
            }
          }
        }
        await runCompletion.completeRun({
          run, agent, issueId, issueRef, signal: executionControl.controller.signal,
          output: {
            handle, outputProgressState, flushOutputProgress,
            get stdoutExcerpt() { return stdoutExcerpt; },
            get stderrExcerpt() { return stderrExcerpt; },
          },
          session: { runtimeForAdapter, previousSessionParams, taskKey, configuredModel, sessionConfigMetadata },
          readFailureReportSecrets,
          adapterResult, sessionCodec, taskSessionForRun, sessionCompaction,
          configFreshnessResultMetadata, runLedgerScope, currentUserRedactionOptions,
          providerTraceCapture: providerTraceCapture !== null,
          onProviderTraceFinalized: () => { providerTraceFinalized = true; },
          issueContext, onLog,
        });
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
        await runCompletion.failRun({
          run, agent, issueId, issueRef, signal: executionControl.controller.signal,
          output: {
            handle, outputProgressState, flushOutputProgress,
            get stdoutExcerpt() { return stdoutExcerpt; },
            get stderrExcerpt() { return stderrExcerpt; },
          },
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
        await runCompletion.failRunSetup({
          run, runId, outerErr, identityRedactor, readFailureReportSecrets,
        });
      }
    } finally {
      await nativeInstructionReservation?.release().catch(error => logger.warn({ runId: run.id, err: error }, "Managed warm session preparation cleanup failed"));
      if (managedAiRuntime) await managedAiRuntime.cleanup().catch(() => logger.warn({ runId: run.id }, "AI connection refresh or cleanup failed"));
      let latestRun = await getRun(run.id).catch(() => null);
      try {
        if (latestRun && isHeartbeatRunTerminalStatus(latestRun.status)) {
          await db
            .update(heartbeatRuns)
            .set({ executionControlDeadlineAt: null })
            .where(eq(heartbeatRuns.id, run.id));
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
          await releaseWarmInstructionPreparation?.();
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
            });
          } catch (scratchCleanupError) {
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
        await db.update(heartbeatRuns).set({
          executionStage: sql`case when ${heartbeatRuns.status} = 'cancelled' then 'settled' else ${heartbeatRuns.executionStage} end`,
          controllerLeaseExpiresAt: null,
        }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.runtimeMode, "legacy"),
          eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
          inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out", "interrupted"])));

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

    getRunLogAccess,

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
      opts?: { offset?: number; limitBytes?: number },
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
    computeTaskDrain,
    applyTaskDrain,

    promoteDueScheduledRetries,
    retryScheduledRetryNow,

    resumeQueuedRuns,

    scheduleBoundedRetry,

    reconcileStrandedAssignedIssues,
    recoverPendingSessionGoalActions,
    recoverActiveSessionGoals,

    terminalizeRunOnLeaseRelease,

    releaseEnvironmentLeasesForRun,
    resumeRemoteStopComments,
    resumeQueuedCommentInterrupt,
    resumeExecutionWaitComments,

    sweepStaleIssueLocks,

    reconcileResolvedDependencyWakes,

    scanSilentActiveRuns,

    reconcileTaskWatchdogs,
    reconcileCostAccounting: async () => {
      await decisionModelService(db, { budgetHooks }).recoverInterrupted();
      return createCostAccountingReconciler(db, budgetHooks)();
    },

    buildRunOutputSilence,

    tickTimers,

    cancelRun: (runId: string, reason?: string, options?: CancelRunOptions) =>
      cancelRunInternal(runId, reason, options),

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

    getActiveRunForAgent,

    getActiveRunIssueSummaryForAgent,
  };
}
