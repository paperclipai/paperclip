import {
  HEARTBEAT_RUN_TERMINAL_STATUSES,
  DETACHED_PROCESS_ERROR_CODE,
  isProcessAlive,
  CANCELLABLE_HEARTBEAT_RUN_STATUSES,
  createHeartbeatRecovery,
} from "./heartbeat/recovery.js";
import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS,
  normalizeAgentNameKey,
  WorkspaceBusyDeferral,
  readTransientRecoveryContractFromRun,
  readHeartbeatRunErrorFamily,
  isWorkspaceBusyDeferral,
  isTransientWorkspaceGitScanCode,
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
  type RunSessionOutcome,
  EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASON,
  deriveTaskKeyWithHeartbeatFallback,
  type UsageTotals,
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
  normalizeUsageTotals,
  resolveCacheAdjustedCostUsd,
  resolveLedgerBiller,
  resolveLedgerCostStatus,
  normalizeLedgerBillingType,
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
import { readGitConnectionFailure } from "./git-connection-failure.js";
import {
  CONFIGURATION_INCOMPLETE_FAILURE_CODE,
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
  enrichWakeContextSnapshot,
  hasInteractionContinuationWakeContext,
  isInteractionResolutionWakePayload,
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
  WORKSPACE_VALIDATION_FAILURE_CODE,
  isWorkspaceValidationFailedRun,
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
import { preserveWorkspaceRestoreRecoveryMetadataSql } from "./legacy-workspace-restore-recovery.js";
import { preserveWorkspaceRestoreRecoveryMetadata } from "./workspace-restore-recovery-state.js";
import { recordLegacyWorkspaceRestoreFailure } from "./legacy-execution-recovery.js";
import {
  configuredEnvironmentProjection,
} from "../vendor/paperclip-runner/index.js";
import { decisionModelService } from "./decision-models.js";
import { activeIssueInteractionCondition } from "./issue-question-context.js";
import { createAgentIdentityRedactor } from "./agent-identity-redaction.js";
import { agentIdentityService, supportsManagedAgentIdentity } from "./agent-identity.js";
import { buildAgentIdentityEnv } from "@paperclipai/adapter-utils/server-utils";

import { prepareConnectionInstructionDelivery } from "./connection-instructions.js";
import { resolveAssignedConnectionInstructionsForRun } from "./native-runtime/assigned-mcp-tools.js";
import { externalObjectService } from "./external-objects.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { dotRunnerBroker } from "./dot-runner-broker.js";
import { isAiAuthenticationBlocked } from "./ai-auth-failure.js";
import { nativeRetryCancellationCommitCondition, rethrowNativeCancellationLockConflict, claimCancellationRequest, startupCancellationFence } from "./native-runtime/native-cancellation-request.js";
import { CHAT_COMPLETION_WAKE_REASON, prepareChatCompletionTurn, chatCompletionInstruction, isCompletedOnboardingHandoffWake, acknowledgeReusedChatCompletionReply } from "./chat-completion-delivery.js";
import { AgentDirectoryReuseInvalidatedError, isAgentDirectoryCopy } from "./agent-directory-working-copies.js";

import type { PaperclipTurnContext } from "@paperclipai/adapter-utils/server-utils";
import { restoreNativeWorkspaceBestEffort } from "./native-runtime/native-workspace-best-effort.js";

import { cancellationResultJson, canContinueCancelledRun, readRunCancellation, requestedRunCancellation } from "./run-cancellation.js";
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
import { compareCents, hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import {
  nonIdleSlackIssueCondition,
} from "./slack-conversation-state.js";
import { settleSlackConversation } from "./slack-conversation-lifecycle.js";
import { toolActionDeliveryService } from "./tool-action-delivery.js";


import { readQueuedInteractionResponse } from "./queued-interaction-response.js";
import { isConversation, isConversationExecutionWake, isWaitingConversation, prepareConversationTurn, settleConversationTurn } from "./agent-conversations.js";
import { withAdapterExecutionPhase } from "@paperclipai/adapter-utils/execution-phase";
import { getConversationConfirmationContext } from "./conversation-confirmation-context.js";
import { PROCESS_IDENTITY_RECORDED, recordNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasAcknowledgedNativeReassignmentStopIntent, hasAcknowledgedNativeStopIntent, isAcknowledgedNativeStop, acknowledgedNativeStopExecutionHasStopped } from "./acknowledged-native-stop.js";
import {
  legacyControllerBootId,
  legacyControllerClaim,
  renewLegacyControllerLease,
  watchLegacyControllerLease,
} from "./legacy-controller-lease.js";
import { completeTerminatedRemoteNativeSessionCleanup } from "../vendor/paperclip-runner/index.js";
import {
  hasRemoteTerminationReceipt,
  remoteExecutionHasStopped,
  stoppedRemoteCleanupScopes,
} from "./remote-execution-termination.js";
import { applyConnectorSkills, prepareConnectorSkillDelivery, resolveConnectorAssignments } from "./connector-runtime.js";
import {
  admitExplicitNativeContinuation,
  undeliveredLegacyUserCommentIds,
} from "./explicit-native-continuation.js";
import { canRetryStoppedRun, isCancelledNativeStartup } from "./cancelled-native-startup.js";
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
import { executionBlockerPredicate, getExecutionBlocker } from "./execution-blocker.js";
import { CONVERSATION_CONTINUATION_POLICY, claimedAdapterType, runUsedConversationAdapter, hasConversationContinuationPolicy, isConversationAdapter } from "./conversation-continuation.js";
import { recordExecutionWait } from "./execution-wait.js";
import { getNativeReviewAssignment, readNativeReviewAssignmentContext } from "./native-runtime/native-review-participant.js";
import { claimQueuedNativeReviewRun } from "./native-runtime/native-review-dispatch.js";
import { buildNativeReviewRequest } from "./native-runtime/native-review-prompt.js";
import {
  legacyExecutionNeedsReconciliationWithEvidence,
  settleInterruptedNativeBootstrap,
  terminalizeLegacyExecution,
} from "./legacy-execution-recovery.js";
import {
  adapterExecutionControls,
  captureAdapterStopOwnership,
  createAdapterExecutionControl,
  registerAdapterExecutionControl,
  waitForAdapterStop,
} from "./adapter-execution-control.js";
import { executionFailureRetryCount } from "./execution-recovery-attempt.js";
import { buildHeartbeatRunStatusLiveEventPayload } from "./heartbeat-run-status-payload.js";
export { buildHeartbeatRunStatusLiveEventPayload } from "./heartbeat-run-status-payload.js";
import { buildExecutionContinuation, StaleExecutionContinuationError } from "./execution-continuation.js";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";

import { isWorkspaceGitScanError } from "./workspace-git-operation-scheduler.js";

import {
  initializeRunIdentity,
} from "./run-identity.js";
import {
  assertDurableChatWakeupReceipt,
  assertDurableChatWakeupRequest,
  authorizeFailedChatRunRetryWake,
  FailedChatRunRetryAuthorizationError,
  unadmittedChatWakeupCondition,
} from "./durable-chat-wakeup.js";
import { prepareHeartbeatGitHubLaunchers } from "./heartbeat-github-launchers.js";
import {
  cleanupGitHubOperationLaunchers,
  prepareGitHubExecutionEnvironment,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import { agentService } from "./agents.js";
import { agentInstructionWorkingCopyService, instructionWorkingCopyGuidance } from "./agent-instruction-working-copies.js";
import { normalizeLegacyRunnerProvider, resolveManagedOpenAiBilling } from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
  CHAT_PROVIDERS,
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  ISSUE_DISPOSITION_REPAIR_RETRY_REASON,
  PROVIDER_QUOTA_MONITOR_SERVICE_NAME,
  isEnvironmentDriverSupportedForAdapter,
  type EnvironmentLeaseStatus,
  type ExecutionWorkspace,
  type HeartbeatRunStatusPhase,
  type IssueExecutionMonitorClearReason,
  type IssueExecutionMonitorPolicy,
  type IssueExecutionMonitorRecoveryPolicy,
  type RequestConfirmationResult,
  type RunLivenessState,
} from "@paperclipai/shared";
import {
  agents,
  agentConfigRevisions,
  agentRuntimeState,
  agentSessionGoalActions,
  agentTaskSessions,
  agentWakeupRequests,
  activityLog,
  approvals,
  chatActions,
  chatConversations,
  chatEndpoints,
  companySkillTestRuns,
  companies,
  completionContracts,
  costEvents,
  documentRevisions,
  environmentLeases,
  issueDocuments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  issueWorkProducts,
  nativeRunFinalizations,
  projects,
  projectWorkspaces,
  routines,
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
  allocateHeartbeatRunEventSeq,
  appendHeartbeatRunEvent,
  type AppendHeartbeatRunEventInput,
} from "./heartbeat-run-events.js";
import {
  queuedCommentIdsFromWakePayload,
  queuedCommentIdsFromRunContext,
  withQueuedCommentIdsInWakePayload,
  withQueuedCommentIdsInRunContext,
} from "./issue-queued-comment-queue.js";
import { documentService } from "./documents.js";
import { getTaskPlanContext } from "./task-plan-context.js";
import { managedAgentProfileService } from "./managed-agent-profiles.js";
import { remoteAgentProfileService } from "./remote-agent-profiles.js";
import {
  buildNativeProviderEnvironment,
  buildNativeExecutionInput,
  buildNativeExecutionWithCheckpoint,
  buildNativeRuntimeContext,
  cancelNativeSession,
  closeWarmNativeSessionsForEnvironment,
  reserveWarmNativeInstructionDirectory,
  dispatchNativeSessionResumptions,
  ensureNativeCompletionContract,
  executePaperclipNativeSession,
  finalizeNativeRun,
  findNativeSessionResumeRun,
  isNativeSessionId,
  isUnusedNativeSessionBootstrap,
  isUnusedLegacyNativeRetryReplacement,
  isRunnerIngressAuthorized,
  materializeLegacyQuestionResponseWakeProjection,
  materializeNativeInteractionResponses,
  nativeCompletionRequestsWithSources,
  nativeCompletionSource,
  nativeImmediateObjectiveSource,
  NativeCancellationPendingRecoveryError,
  NativeControllerDetachedForRestartError,
  nativeToolContractFingerprintForTarget,
  prepareNativeSessionBootstrapPersistence,
  prepareNativeWorkspaceSync,
  recordNativeFinalizationFailure,
  type NativeRestartRecoveryClaim,
  rebindNativeSessionCheckpoint,
  resolveHeartbeatNativeRuntimeMode,
} from "./native-runtime/index.js";
import {
  assertAgentCoreProfileRecoveryBinding,
  assertManagedProfileRecoveryBinding,
  projectPaperclipRunnerTaskConfig,
  resolvePaperclipRunnerNativeProviderInput,
} from "./native-runtime/provider-profile.js";
import { readRemoteCodexModelCliVersion } from "./native-runtime/codex-model-fallback.js";
import {
  buildNativeHeartbeatPreparationSpans,
  buildNativeWakeIngressSpan,
  recordFailedSkillPreparation,
  type NativeRunHistoricalSpan,
} from "./native-runtime/native-run-trace.js";
import {
  describeRunnerdNativeSessionBackend,
  parseNativeExecutionInput,
  type NativeExecutionInput,
  type NativeSessionGoalControl,
  type NativeSessionBackend,
} from "../vendor/paperclip-runner/index.js";
import { createNativeSessionHandoffLoader } from "./native-runtime/native-session-handoff.js";
import { normalizeResponsibleUserDenialCode } from "./responsible-user-denial-run-outcomes.js";
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
  asBoolean,
  asNumber,
} from "../adapters/utils.js";
import {
  isExternalChatWaitAuthorizationContention,
} from "./native-runtime/chat-attachment-reuse.js";
import {
  EXTERNAL_CHAT_QUESTION_RESPONSE_KEY,
} from "./native-runtime/external-chat-question-response.js";
import { materializeExternalChatQuestionResponseInput } from "./native-runtime/external-chat-question-response-input.js";
import {
  NativeRunnerOwnershipUnverifiedError,
  isNativeRunnerOwnershipHeld,
  nativeRunnerOwnershipNotHeldCondition,
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
import { budgetService, withCurrentBudgetEnforcement, type BudgetEnforcementScope } from "./budgets.js";
import {
  secretService,
} from "./secrets.js";
import {
  resolveDefaultAgentWorkspaceDir,
} from "../home-paths.js";
import {
  buildHeartbeatRunIssueComment,
  CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON,
  findHeartbeatRunCompletionComment,
  hasAcceptedSemanticResult,
  isExternalChatPresentationContext,
  mergeHeartbeatRunResultJson,
  readCompletedAssistantMessageCandidate,
  resolveHeartbeatRunResponse,
  selectHeartbeatRunFinalAgentMessage,
  type RunPresentationDecision,
} from "./heartbeat-run-summary.js";
import {
  buildHeartbeatRunStopMetadata,
  mergeHeartbeatRunStopMetadata,
  normalizeMaxTurnStopReason,
} from "./heartbeat-stop-metadata.js";
import {
  CHAT_CONTROL_RECOVERY_ADMISSION_KEY,
  CHAT_CONTROL_RECOVERY_STOP_CODE,
  CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
  chatControlRecoveryAdmission,
  readChatControlRecoveryAdmission,
  readChatControlNativeParent,
  readChatControlRecoveryStop,
} from "./chat-control-recovery-stop.js";
import {
  classifyRunLiveness,
  type RunLivenessClassificationInput,
} from "./run-liveness.js";
import {
  ISSUE_NEW_INPUT_ACTIVITY_ACTIONS,
  ISSUE_PROGRESS_ACTIVITY_ACTIONS,
  ISSUE_REWAKE_LOOKBACK_MS,
  ISSUE_REWAKE_RUN_SAMPLE_LIMIT,
  evaluateIssueRewakeThrottle,
  isThrottleCandidateIssueRewake,
} from "./issue-rewake-throttle.js";
import {
  logActivity,
  publishPluginDomainEvent,
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
  isUnresolvedWorkspaceBaseRefError,
  type ExecutionWorkspaceInput,
  type RealizedExecutionWorkspace,
  type RuntimeServiceRef,
  type UnresolvedWorkspaceBaseRefError,
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
  runnerGoalService,
  settleLiveRunnerGoalBeforeInterrupt,
} from "./runner-goals.js";
import { resolveChatRunPresentationAuthorizationReason } from "./chat-run-publications.js";



import { visibleIssueCondition } from "./issue-visibility.js";
import { ISSUE_BLOCKERS_RESOLVED_WAKE_REASON } from "./issue-dependency-wakeups.js";
import {
  buildIssueMonitorClearedPatch,
  buildIssueMonitorTriggeredPatch,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import {
  ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
  isVerifiedIssueTreeControlInteractionWake,
  issueTreeControlService,
} from "./issue-tree-control.js";
import {
  continuationSummaryParksExecutor,
  getIssueContinuationSummaryDocument,
  refreshIssueContinuationSummary,
} from "./issue-continuation-summary.js";
import {
  buildPlanReviewContext,
} from "./plan-review-context.js";
import {
  executionWorkspaceService,
} from "./execution-workspaces.js";
import {
  workspaceOperationService,
} from "./workspace-operations.js";
import {
  isProcessGroupAlive,
  terminateLocalService,
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
  isUnrunnableWorktreeCombo,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveEffectiveWorkspaceStrategyType,
  resolveExecutionWorkspaceEnvironmentId,
  resolveExecutionWorkspaceMode,
  resolveSharedWorkspaceConcurrency,
  selectEnvironmentExecutionWorkspaceSettings,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
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
} from "./recovery/index.js";
import {
  buildConfigurationIncompleteRecoveryNoticeSeed,
  buildExecutionReviewParticipantRecoveryNoticeSeed,
  buildImmediateExecutionPathRecoveryNoticeSeed,
  buildWorkspaceValidationRecoveryNoticeSeed,
  SANDBOX_PROVIDER_PLUGIN_NOT_READY_REASON,
  type StrandedRecoveryNoticeSeed,
} from "./recovery/stranded-notice.js";
import { withRecoveryContext } from "./recovery/status-only-context.js";
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
  allowsIssueInteractionWake,
  isResolvedInteractionContinuationWakeContext,
} from "../modules/run-dispatch/index.js";
import {
  createWakeQueue,
  WakeQueueApplicationError,
  type IssueSnapshot as WakeQueueIssueSnapshot,
  type PostCommitEffect as WakeQueuePostCommitEffect,
  type ReleaseRecoveryBlockedNoticeKind,
  type RunSnapshot as WakeQueueRunSnapshot,
} from "../modules/wake-queue/index.js";
import {
  buildIssueReviewPathLostIdempotencyKey,
  decideIssueReviewPathRecovery,
  ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
  isReviewPathRecoveryIdempotencyConflict,
  REVIEW_PATH_RECOVERY_INSTRUCTION,
  reviewPathConsumedRefFromRun,
} from "./recovery/review-path-recovery.js";
import { resolveRequiredSuccessfulRunHandoffOnValidPath } from "./successful-run-handoff-state.js";
import { taskWatchdogService } from "./task-watchdogs.js";
import { withAgentStartLock } from "./agent-start-lock.js";
import {
  evaluateAgentInvokability,
  evaluateAgentInvokabilityFromDb,
  shouldCancelRunsForNonInvokableAgent,
  DIRECT_NON_INVOKABLE_STATUSES,
  type AgentOrgRow,
} from "./agent-invokability.js";
import { isHeartbeatWakeOnDemandEnabled } from "./heartbeat-policy.js";
import {
  redactQuarantinedBodyForHigherTrust,
  sanitizeQuarantinedCommentForHigherTrust,
} from "./source-trust.js";
import {
  redactCurrentUserText,
  redactCurrentUserValue,
  type CurrentUserRedactionOptions,
} from "../log-redaction.js";
import { redactEventPayload, redactSensitiveText } from "../redaction.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";
import {
  resolvePaperclipRunnerIdleTimeoutMs,
  type RuntimeStatusUpdate,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipSkillSyncPreference,
  selectPaperclipTaskMarkdown,
  UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON,
  UNMANAGED_BACKGROUND_TASK_STOP_REASON,
} from "@paperclipai/adapter-utils/server-utils";
import {
  isUuidLike,
} from "@paperclipai/shared";

import { environmentService } from "./environments.js";
import { parseExecutionPolicyBootstrapEnv } from "./execution-policy-bootstrap.js";
import { retryChatControlAdmission } from "./chat-control-admission-retry.js";
import {
  environmentRuntimeService,
  type ProviderResourceDisposition,
} from "./environment-runtime.js";
import { skillVersionSelectionMap } from "./runtime-skill-selections.js";
import { environmentRunOrchestrator } from "./environment-run-orchestrator.js";

import {
  clearHeartbeatRunRuntimeStatus,
  getHeartbeatRunRuntimeStatus,
  MAX_HEARTBEAT_RUN_RUNTIME_ASSISTANT_SNIPPET_CHARS,
  MAX_HEARTBEAT_RUN_RUNTIME_TOOL_NAME_CHARS,
  setHeartbeatRunRuntimeStatus,
  sweepExpiredHeartbeatRunRuntimeStatuses,
  touchHeartbeatRunRuntimeStatus,
} from "./heartbeat-run-runtime-status.js";
import {
  readProcessStartedAt,
} from "./hot-restart.js";
import {
  assertLowTrustRuntimeServicesAllowed,
} from "./low-trust-runtime-containment.js";

import { resolveAndRetainRunTrustPreset } from "./run-trust-preset.js";

import type { PluginWorkerManager } from "./plugin-worker-manager.js";

import { computeTaskDrain, applyTaskDrain, startTaskDrain, stopTaskDrain, readTaskDrain } from "./task-admission.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;

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

const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MIN = 1;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 50;
const LIVENESS_BOOKKEEPING_ACTIVITY_ACTIONS = [
  "environment.lease_acquired",
  "environment.lease_released",
  "cost.reported",
];
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";

const ACCEPTED_PLAN_CONVERSION_SKILL_KEY =
  "paperclipai/paperclip/paperclip-converting-plans-to-tasks";

const execFile = promisify(execFileCallback);
const EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = [
  "queued",
  "running",
  "scheduled_retry",
] as const;

const UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES = [
  "failed",
  "cancelled",
  "timed_out",
] as const;
const TIMER_ACTIONABLE_ISSUE_STATUSES = ["todo", "in_progress"] as const;
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

const NON_RETRYABLE_PREFLIGHT_FAILURE_CODES = new Set<string>([
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
class ChatControlRecoveryUnresolvedError extends Error {
  constructor() {
    super(
      "Run admission could not acquire its database locks after bounded retries. No provider work started. Review database contention and send a fresh request; this attempt will not automatically retry.",
    );
  }
}

export { MAX_TURN_CONTINUATION_RETRY_REASON };
export const MAX_TURN_CONTINUATION_WAKE_REASON = "max_turns_continuation_retry";
const MAX_TURN_CONTINUATION_DEFAULT_MAX_ATTEMPTS = 2;
const MAX_TURN_CONTINUATION_MAX_ATTEMPTS_CAP = 10;
const MAX_TURN_CONTINUATION_DEFAULT_DELAY_MS = 1_000;
const MAX_TURN_CONTINUATION_MAX_DELAY_MS = 5 * 60 * 1000;

export { WORKSPACE_BUSY_RETRY_REASON };

interface MaxTurnContinuationPolicy {
  enabled: boolean;
  maxAttempts: number;
  delayMs: number;
}

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
  return {
    configurationIncomplete: {
      reason: "workspace_base_ref_unresolved",
      companyId: run.companyId,
      agentId: run.agentId,
      issueId: readNonEmptyString(context.issueId) ?? null,
      projectId: readNonEmptyString(context.projectId) ?? null,
      requestedRef: error.requestedRef,
      attemptedRefs: error.attemptedRefs,
      fetchError: error.fetchError,
      fingerprint: `workspace_base_ref:${error.recoveryIdentityRef}`,
      missingBindings: [],
    },
  };
}

export { isNonAssigneeWorkspaceBusyRetry };

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
const RUNNING_ISSUE_WAKE_REASONS_REQUIRING_FOLLOWUP = new Set([
  CHAT_COMPLETION_WAKE_REASON,
  "approval_approved",
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  "issue_recovery_action_restored",
]);

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

export function leaseReleaseStatusForRunStatus(
  status: string | null | undefined,
): Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed"> {
  if (status === "cancelled") return "expired";
  return status === "failed" || status === "timed_out" ? "failed" : "released";
}

export function providerResourceDispositionForTerminalRun(
  desired: ProviderResourceDisposition | undefined,
  status: string | null | undefined,
): ProviderResourceDisposition | undefined {
  if (desired !== "keep_running") return desired;
  return status === "succeeded" ? desired : "stop_and_retain";
}

export interface NativeSandboxLifecycle {
  runnerProcess: "per_turn" | "warm";
  sandboxResource: "keep_running" | "stop_and_reuse" | "destroy_after_turn";
  failoverBackup: "verified";
}

export function resolveReusableSandboxLifecycle(input: {
  lifecyclePolicy:
    | { mode: "per_turn"; idleTimeoutMs: null }
    | { mode: "warm"; idleTimeoutMs: number };
  target: {
    kind: "local" | "remote";
    transport?: string;
    reusableLeaseConfigured?: boolean;
    effectiveCapabilities?: { reusableLeases: boolean } | null;
  } | null;
}): NativeSandboxLifecycle | null {
  if (input.target?.kind !== "remote" || input.target.transport !== "sandbox") {
    return null;
  }
  const reusableLease =
    input.target.reusableLeaseConfigured === true &&
    input.target.effectiveCapabilities?.reusableLeases === true;
  if (input.lifecyclePolicy.mode === "warm" && !reusableLease) {
    throw new Error("runner_warm_lifecycle_requires_reusable_provider_lease");
  }
  return {
    runnerProcess: input.lifecyclePolicy.mode,
    sandboxResource:
      input.lifecyclePolicy.mode === "warm"
        ? "keep_running"
        : reusableLease
          ? "stop_and_reuse"
          : "destroy_after_turn",
    failoverBackup: "verified",
  };
}

export function resolveNativeSandboxLifecycle(input: {
  adapterType: string;
  lifecyclePolicy:
    | { mode: "per_turn"; idleTimeoutMs: null }
    | { mode: "warm"; idleTimeoutMs: number };
  target: {
    kind: "local" | "remote";
    transport?: string;
    reusableLeaseConfigured?: boolean;
    effectiveCapabilities?: { reusableLeases: boolean } | null;
  } | null;
}): NativeSandboxLifecycle | null {
  if (
    input.adapterType !== "paperclip_runner" ||
    input.target?.kind !== "remote" ||
    input.target.transport !== "sandbox"
  )
    return null;
  return resolveReusableSandboxLifecycle(input);
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



function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(
    asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT),
  );
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(
    HEARTBEAT_MAX_CONCURRENT_RUNS_MIN,
    Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed),
  );
}

interface ParsedIssueAssigneeAdapterOverrides {
  adapterConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseNativeSessionGoalControl(
  value: unknown,
): NativeSessionGoalControl | null {
  const candidate = parseObject(value);
  const requestId = readNonEmptyString(candidate.requestId);
  const action = readNonEmptyString(candidate.action);
  if (
    !requestId ||
    !action ||
    !["create", "edit", "replace", "pause", "resume", "clear"].includes(action)
  )
    return null;
  const objective = readNonEmptyString(candidate.objective);
  const tokenBudget =
    candidate.tokenBudget === null
      ? null
      : typeof candidate.tokenBudget === "number" &&
          Number.isSafeInteger(candidate.tokenBudget) &&
          candidate.tokenBudget > 0
        ? candidate.tokenBudget
        : undefined;
  return {
    requestId,
    action: action as NativeSessionGoalControl["action"],
    ...(objective ? { objective } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  };
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

function shouldRequireIssueCommentForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.skipIssueComment === true) return false;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  return (
    wakeReason === "issue_assigned" ||
    wakeReason === "execution_review_requested" ||
    wakeReason === "execution_approval_requested" ||
    wakeReason === "execution_changes_requested"
  );
}

async function listUnresolvedBlockerSummaries(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  issueId: string,
  unresolvedBlockerIssueIds: string[],
) {
  const ids = [...new Set(unresolvedBlockerIssueIds.filter(Boolean))];
  if (ids.length === 0) return [];
  return dbOrTx
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.relatedIssueId, issueId),
        inArray(issues.id, ids),
      ),
    )
    .orderBy(asc(issues.title));
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

export function shouldDeferFollowupWakeForSameIssue(input: {
  activeRunStatus: string | null | undefined;
  isSameExecutionAgent: boolean;
  wakeCommentId: string | null | undefined;
  forceFreshSession: boolean;
}) {
  // A comment follow-up or explicit fresh-session wake needs a new run boundary.
  if (!input.isSameExecutionAgent) return false;
  if (input.activeRunStatus !== "running") return false;
  if (input.wakeCommentId) return true;
  if (input.forceFreshSession) return true;
  return false;
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

export function shouldQueueFollowupForRunningIssueWake(input: {
  contextSnapshot: Record<string, unknown> | null | undefined;
  wakeCommentId: string | null;
}) {
  if (input.wakeCommentId) return true;
  // A structured interaction response is new input just like a comment. It
  // must run after the turn that created the interaction instead of being
  // merged into that still-running turn.
  if (
    readNonEmptyString(input.contextSnapshot?.interactionId) &&
    readNonEmptyString(input.contextSnapshot?.interactionStatus)
  ) {
    return true;
  }
  const wakeReason = readNonEmptyString(input.contextSnapshot?.wakeReason);
  if (wakeReason === "issue_children_completed" && (
    input.contextSnapshot?.onboardingCompletion === true ||
    (input.contextSnapshot?.statusDecisionSource === "native_status_decision" &&
      readNonEmptyString(input.contextSnapshot?.nativeChildCompletionDecisionId))
  )) return true;
  return Boolean(
    wakeReason && RUNNING_ISSUE_WAKE_REASONS_REQUIRING_FOLLOWUP.has(wakeReason),
  );
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

function isHeartbeatRunTerminalStatus(
  status: string | null | undefined,
): status is (typeof HEARTBEAT_RUN_TERMINAL_STATUSES)[number] {
  return HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
    status as (typeof HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
  );
}

function isHeartbeatRunRuntimeStatusActive(
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

function decorateHeartbeatRunRuntimeStatus<
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

function publishHeartbeatRunRuntimeProgress(status: {
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
  meta: { pid: number; processGroupId: number | null; startedAt: string },
) {
  const observedStartedAt = await readProcessStartedAt(meta.pid).catch(
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

async function terminateHeartbeatRunProcess(input: {
  pid: number | null | undefined;
  processGroupId: number | null | undefined;
  graceMs?: number;
  signal?: NodeJS.Signals;
}) {
  const pid = input.pid ?? null;
  const processGroupId = input.processGroupId ?? null;
  if (typeof pid !== "number" && typeof processGroupId !== "number") return;

  await terminateLocalService(
    {
      pid:
        typeof pid === "number" && Number.isInteger(pid) && pid > 0
          ? pid
          : (processGroupId ?? 0),
      processGroupId:
        typeof processGroupId === "number" &&
        Number.isInteger(processGroupId) &&
        processGroupId > 0
          ? processGroupId
          : null,
    },
    { forceAfterMs: input.graceMs, signal: input.signal },
  );
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

export async function cancelHeartbeatNativeRun(input: {
  db: Db;
  runId: string;
  reason: string;
  runtimeMode: string | null;
  cancellationRequestId?: string;
  cancel?: (
    runId: string,
    reason: string,
    options: { db: Db; scope: "run"; cancellationRequestId?: string },
  ) => Promise<{ decision: unknown | null; auditId: string | null }>;
}) {
  if (input.runtimeMode !== "native") {
    return { decision: null, auditId: null };
  }
  const cancellation = input.cancel
    ? await input.cancel(input.runId, input.reason, {
        db: input.db,
        scope: "run",
        ...(input.cancellationRequestId ? { cancellationRequestId: input.cancellationRequestId } : {}),
      })
    : await cancelNativeSession(input.runId, input.reason, {
        db: input.db,
        scope: "run",
        ...(input.cancellationRequestId ? { cancellationRequestId: input.cancellationRequestId } : {}),
      });
  if (!cancellation.decision || !cancellation.auditId) {
    throw new Error("native_cancellation_outcome_not_audited");
  }
  return cancellation;
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

export async function postNativeModelFallbackWarning(input: {
  issuesSvc: Pick<ReturnType<typeof issueService>, "addComment">;
  onEvent: (event: AdapterRuntimeEvent) => Promise<void>;
  issueId: string;
  runId: string;
  requestedModel: string | null;
  effectiveModel: string | null;
  codexCliVersion: string;
}): Promise<void> {
  const message = `Using ${input.effectiveModel} because the sandbox's Codex ${input.codexCliVersion} does not support ${input.requestedModel}. Work will continue with the compatible model. Update the sandbox's Codex CLI to use the requested model.`;
  await input.onEvent({
    eventType: "runner.model_fallback",
    stream: "system",
    level: "warn",
    message,
    payload: {
      requestedModel: input.requestedModel,
      effectiveModel: input.effectiveModel,
      codexCliVersion: input.codexCliVersion,
    },
  });
  await input.issuesSvc.addComment(input.issueId, message, { runId: input.runId }, {
    authorType: "system",
    presentation: {
      kind: "system_notice",
      tone: "warning",
      title: `Using ${input.effectiveModel}`,
      density: "compact",
      detailsDefaultOpen: false,
    },
  });
}

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

  const taskWatchdogs = taskWatchdogService(db, { enqueueWakeup });
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

  async function releaseEnvironmentLeasesForRun(input: {
    runId: string;
    companyId: string;
    agentId: string;
    status: string | null | undefined;
    failureReason?: string | null;
    providerResourceDisposition?: ProviderResourceDisposition;
    nativeLifecycleTelemetry?: {
      provider: string;
      harness: string;
      lifecycleMode: "per_turn" | "warm";
      sandboxResource: "keep_running" | "stop_and_reuse" | "destroy_after_turn";
    };
  }) {
    const leaseOwnerRun = await getRun(input.runId);
    if (leaseOwnerRun && isNativeRunnerOwnershipHeld(leaseOwnerRun)) return;
    // Recovery can finish workspace copy-back outside the executor's finally.
    // Successful copy-back does not earn warm retention for a failed turn.
    const status = leaseOwnerRun?.status ?? input.status;
    const providerResourceDisposition = providerResourceDispositionForTerminalRun(
      input.providerResourceDisposition,
      status,
    );
    if (providerResourceDisposition === "destroy") {
      const closeResult = await (
        options.closeWarmNativeSessionsForRun ??
        (async ({ runId, reason }) => {
          const environmentIds = await db
            .selectDistinct({ environmentId: environmentLeases.environmentId })
            .from(environmentLeases)
            .where(
              and(
                eq(environmentLeases.heartbeatRunId, runId),
                eq(environmentLeases.status, "active"),
              ),
            )
            .then((rows) =>
              rows.flatMap((row) =>
                typeof row.environmentId === "string" &&
                row.environmentId.length > 0
                  ? [row.environmentId]
                  : [],
              ),
            );
          const aggregate = { closed: 0, busy: 0, failed: 0 };
          for (const environmentId of environmentIds) {
            const result = await closeWarmNativeSessionsForEnvironment({
              environmentId,
              reason,
            });
            aggregate.closed += result.closed;
            aggregate.busy += result.busy;
            aggregate.failed += result.failed;
          }
          return aggregate;
        })
      )({
        runId: input.runId,
        reason: "terminal heartbeat run destroyed its environment lease",
      }).catch((err) => {
        logger.warn(
          { err, runId: input.runId },
          "failed to close warm native sessions before environment lease destruction",
        );
        return { closed: 0, busy: 0, failed: 1 };
      });
      // A failed remote checkpoint cannot veto destruction of the isolated
      // sandbox after the run stopped. Provider destruction supplies the exit
      // proof; it does not turn the interrupted checkpoint into a success.
      const remoteLeases = closeResult.failed > 0 && leaseOwnerRun &&
          ["cancelled", "failed", "timed_out", "interrupted"].includes(leaseOwnerRun.status)
        ? await db.select({ provider: environmentLeases.provider }).from(environmentLeases).where(and(
            eq(environmentLeases.companyId, input.companyId),
            eq(environmentLeases.heartbeatRunId, input.runId),
          ))
        : [];
      const canDestroyRemote = remoteLeases.length > 0 &&
        remoteLeases.every(lease => lease.provider && lease.provider !== "local");
      if (closeResult.busy > 0 || (closeResult.failed > 0 && !canDestroyRemote)) {
        logger.warn(
          { runId: input.runId, warmNativeSessions: closeResult },
          "deferred environment lease destruction until warm native sessions close",
        );
        return;
      }
    }
    const releaseResult = await envOrchestrator
      .releaseForRun({
        heartbeatRunId: input.runId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: leaseReleaseStatusForRunStatus(status),
        failureReason: input.failureReason ?? undefined,
        providerResourceDisposition,
        nativeLifecycleTelemetry: input.nativeLifecycleTelemetry,
      })
      .catch((err) => {
        logger.warn(
          { err, runId: input.runId },
          "failed to release environment leases for heartbeat run",
        );
        return null;
      });
    for (const releaseError of releaseResult?.errors ?? []) {
      logger.warn(
        {
          err: releaseError.error,
          leaseId: releaseError.leaseId,
          runId: input.runId,
        },
        "failed to release environment lease for heartbeat run",
      );
    }
    await acknowledgeRemoteStop(input.runId, input.companyId);
  }

  async function acknowledgeRemoteStop(runId: string, companyId: string) {
    // The provider receipt arrives after adapter settlement. A remote ACP child
    // has no host PID, so only this target-aware boundary can acknowledge Stop.
    const stopped = await getRun(runId);
    if (stopped?.runtimeMode === "native") {
      const scopes = await stoppedRemoteCleanupScopes(db, companyId, runId);
      for (const remoteCleanupScope of scopes ?? []) {
        completeTerminatedRemoteNativeSessionCleanup({ companyId, runId, remoteCleanupScope });
      }
    }
    if (stopped?.runtimeMode === "legacy" && stopped.status === "cancelled" &&
        parseObject(stopped.resultJson?.executionCancellation).state === "requested" &&
        await runUsedConversationAdapter(db, stopped) &&
        await remoteExecutionHasStopped(db, companyId, runId)) {
      await db.update(heartbeatRuns).set({
        resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
          executionCancellation: { ...parseObject(stopped.resultJson?.executionCancellation),
            state: "acknowledged", acknowledgedAt: new Date().toISOString(),
            proof: "provider_termination_receipt" },
          conversationContinuation: CONVERSATION_CONTINUATION_POLICY,
                 })}::jsonb`,
        updatedAt: new Date(),
      }).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.status, "cancelled")));
    }
  }

  async function resumeRemoteStopComments(run: typeof heartbeatRuns.$inferSelect, requestId?: string) {
    if (!isHeartbeatRunTerminalStatus(run.status) || adapterExecutionControls.has(run.id)) return;
    const [preparationCoordinator] = run.runtimeMode === "legacy" && run.status === "cancelled" && !run.runtimeModeResolvedAt
      ? await db.select().from(nativeRunFinalizations).where(and(
          eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
        )) : [];
    const cancelledPreparation = run.runtimeMode === "legacy" &&
      await isCancelledNativeStartup(db, run, preparationCoordinator);
    if (run.runtimeMode !== "native" && !cancelledPreparation &&
        parseObject(run.resultJson?.startupCancellation).beforeNativeSelection !== true &&
        !(await remoteExecutionHasStopped(db, run.companyId, run.id))) return;
    const issueId = run.nativeIssueId ?? (typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null);
    if (!issueId) return;
    const currentRun = run.runtimeMode === "native" ? await getRun(run.id, { includeExecutionEvidence: true }) : null;
    const [coordinator] = currentRun ? await db.select({ phase: nativeRunFinalizations.phase,
      leaseOwner: nativeRunFinalizations.leaseOwner }).from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
    )) : [];
    // Stop ends one response. Saved user input can enter ordinary admission
    // once its executor settles; it does not need a manufactured crash incident.
    // The ordinary path still enforces task holds, ownership, and native session
    // cleanup before starting a provider.
    const stoppedNativeContinuation = currentRun && isAcknowledgedNativeStop(currentRun) &&
      !activeRunExecutions.has(run.id) && !coordinator?.leaseOwner &&
      ["terminal_failure", "applied"].includes(coordinator?.phase ?? "") &&
      await acknowledgedNativeStopExecutionHasStopped(db, currentRun) &&
      !(await getExecutionBlocker(db, run.companyId, issueId));
    const legacyContinuation = run.runtimeMode === "legacy" &&
      hasConversationContinuationPolicy((await getRun(run.id, { includeExecutionEvidence: true }))?.resultJson) &&
      !(await getExecutionBlocker(db, run.companyId, issueId));
    if (run.runtimeMode !== "native" && run.runtimeMode !== "legacy") return;
    const pending = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
      eq(agentWakeupRequests.requestedByActorType, "user"),
      requestId ? eq(agentWakeupRequests.id, requestId) : undefined,
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    )).orderBy(asc(agentWakeupRequests.requestedAt)).limit(50);
    for (const wake of pending) {
      if (wake.idempotencyKey?.startsWith("chat-inbound:")) continue;
      let payload = parseObject(wake.payload);
      if (payload.queuedCommentInterrupt) {
        await resumeQueuedCommentInterrupt(wake.companyId, wake.id);
        continue;
      }
      let context = parseObject(payload[DEFERRED_WAKE_CONTEXT_KEY]);
      let commentId = deriveCommentId(context, payload);
      let requestedByActorId = wake.requestedByActorId;
      const reason = readNonEmptyString(context.wakeReason) ?? wake.reason;
      if (run.runtimeMode === "native" || cancelledPreparation) {
        const ids = await undeliveredLegacyUserCommentIds(db, run.companyId, issueId, run.agentId,
          queuedCommentIdsFromWakePayload(payload));
        if (!ids.length) continue;
        payload = withQueuedCommentIdsInWakePayload(payload, ids);
        context = withQueuedCommentIdsInRunContext(context, ids);
        commentId = ids.at(-1)!;
        // A coalesced queue can contain several authors. Its saved comments,
        // not the outer wake's first author, authorize the remaining input.
        const [author] = await db.select({ id: issueComments.authorUserId }).from(issueComments).where(and(
          eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId), eq(issueComments.id, commentId),
        ));
        requestedByActorId = author?.id ?? null;
      }
      if (legacyContinuation || stoppedNativeContinuation) {
        if (!commentId || !run.finishedAt || !requestedByActorId ||
            !["issue_commented", "issue_reopened_via_comment"].includes(reason ?? "")) continue;
        const [comment] = await db.select().from(issueComments).where(and(
          eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId),
          sql`${issueComments.id}::text = ${commentId}`, eq(issueComments.authorType, "user"),
          eq(issueComments.authorUserId, requestedByActorId), isNull(issueComments.deletedAt),
          isNull(issueComments.createdByRunId),
          stoppedNativeContinuation ? undefined : gt(issueComments.createdAt, run.finishedAt),
        ));
        if (!comment?.body.trim()) continue;
      } else {
        let wait = { reason: "execution_recovery", message: "Waiting for execution recovery. Your message is saved." };
        const admitted = await admitExplicitNativeContinuation({ db, companyId: run.companyId, issueId,
          agentId: run.agentId, actorType: wake.requestedByActorType, actorId: requestedByActorId,
          reason, commentId, successorRunId: randomUUID(), dryRun: true,
          ...((run.runtimeMode === "native" || cancelledPreparation) ? { queuedCommentRequestId: wake.id } : {}),
          onBlocked: (reason, message) => { wait = { reason, message }; },
        });
        if (!admitted) {
          await db.update(agentWakeupRequests).set({
            payload: sql`jsonb_set(coalesce(${agentWakeupRequests.payload}, '{}'::jsonb), '{executionWait}',
              coalesce(${agentWakeupRequests.payload}->'executionWait', '{}'::jsonb) || ${JSON.stringify(wait)}::jsonb)`,
            updatedAt: new Date(),
          }).where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.companyId, run.companyId),
            eq(agentWakeupRequests.status, "deferred_issue_execution")));
          continue;
        }
      }
      // Re-enter ordinary admission with the original user's authority. It
      // atomically adopts the deferred comments and still applies every gate.
      await enqueueWakeup(run.agentId, { source: wake.source as WakeupOptions["source"], triggerDetail: (wake.triggerDetail ?? undefined) as WakeupOptions["triggerDetail"],
        reason, payload, contextSnapshot: context,
        requestedByActorType: "user", requestedByActorId,
        ...((run.runtimeMode === "native" || cancelledPreparation) ? { queuedCommentRequestId: wake.id } : {}),
        idempotencyKey: `remote-stop-comment:${run.id}:${wake.id}` }, wake.id);
      break;
    }
  }

  async function resumeQueuedCommentInterrupt(companyId: string, queueId: string, opts?: { retryCleanup?: boolean }) {
    return resumeSavedLegacyComments(companyId, queueId, true, opts);
  }

  async function resumeSavedLegacyComments(companyId: string, queueId: string, interrupted = false, opts?: { retryCleanup?: boolean }) {
    const [wake] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, queueId), eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ));
    if (!wake) return;
    const payload = parseObject(wake.payload);
    let actorId = readNonEmptyString(parseObject(payload.queuedCommentInterrupt).actorId);
    let commentIds = queuedCommentIdsFromWakePayload(payload);
    const issueId = readNonEmptyString(payload.issueId);
    if (!issueId || wake.idempotencyKey?.startsWith("chat-inbound:")) return;
    const response = await readQueuedInteractionResponse(db, companyId, issueId, payload);
    if (!commentIds.length && !response) return;
    // Resolved cards are immutable input. Only an explicit Interrupt click can
    // authorize continuation across a stopped execution; ordinary completion
    // uses normal deferred-wake promotion.
    if (response && !interrupted) return;
    if (!interrupted) {
      commentIds = await undeliveredLegacyUserCommentIds(db, companyId, issueId, wake.agentId, commentIds);
      if (!commentIds.length) return;
      // The queue itself may have begun as a system wake. The saved human
      // comment, not that wake's origin or mutable caller payload, is authority.
      const [comment] = await db.select().from(issueComments).where(and(
        eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
        eq(issueComments.id, commentIds[commentIds.length - 1]!), eq(issueComments.authorType, "user"),
        isNull(issueComments.createdByRunId), isNull(issueComments.deletedAt),
      )).orderBy(desc(issueComments.createdAt)).limit(1);
      if (!comment?.body.trim() || !comment.authorUserId) return;
      actorId = comment.authorUserId;
    }
    if (!actorId) return;
    const agent = await getAgent(wake.agentId);
    if (!agent || agent.companyId !== companyId || (agent.adapterType === "paperclip_runner" && !response?.source.requiresFreshSession)) return;
    const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, wake.agentId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      inArray(heartbeatRuns.status, ["running", "queued", "scheduled_retry"]),
    )).limit(1);
    if (active) return;
    if (interrupted && opts?.retryCleanup) {
      // Only the HTTP click grants an extra cleanup attempt. Periodic retries
      // reuse the intent to deliver, never a fresh provider teardown budget.
      const sourceRun = await db.transaction(async tx => {
        const [task] = await tx.select().from(issues).where(and(
          eq(issues.companyId, companyId), eq(issues.id, issueId),
        )).for("update");
        const [current] = await tx.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.id, queueId), eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, wake.agentId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
          sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt'->>'actorId' = ${actorId}`,
        ));
        if (!task || task.assigneeAgentId !== wake.agentId || ["done", "cancelled"].includes(task.status) ||
            !current || (!queuedCommentIdsFromWakePayload(current.payload).length &&
              !await readQueuedInteractionResponse(tx as unknown as Db, companyId, issueId, current.payload))) return null;
        const [successor] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, wake.agentId),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
          inArray(heartbeatRuns.status, ["running", "queued", "scheduled_retry"]),
        )).limit(1);
        if (successor) return null;
        const blocker = await getExecutionBlocker(tx as unknown as Db, companyId, issueId);
        const run = blocker?.runId ? await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, blocker.runId),
          eq(heartbeatRuns.agentId, wake.agentId), eq(heartbeatRuns.runtimeMode, "legacy"),
          inArray(heartbeatRuns.status, ["failed", "timed_out", "interrupted", "cancelled"]),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
        )).then(rows => rows[0]) : null;
        if (!run || activeRunExecutions.has(run.id) || adapterExecutionControls.has(run.id)) return null;
        // Older ephemeral leases recorded successful cleanup without a provider
        // receipt. Re-verify them through the recorded teardown path; a timestamp
        // alone never certifies termination. Retained/reusable resources stay put.
        const historical = await tx.select().from(environmentLeases).where(and(
          eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, run.id),
          eq(environmentLeases.leasePolicy, "ephemeral"), isNotNull(environmentLeases.releasedAt),
          inArray(environmentLeases.status, ["released", "expired", "failed"]),
        )).for("update");
        for (const lease of historical) {
          if (!lease.provider || lease.provider === "local" || !lease.providerLeaseId || hasRemoteTerminationReceipt(lease)) continue;
          // Provider resource IDs identify physical sandboxes. A lease in any
          // company can still own this resource; never destroy it on behalf of
          // this company. This existence-only guard exposes no foreign data.
          const [otherOwner] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
            ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider),
            eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
            or(isNull(environmentLeases.releasedAt), inArray(environmentLeases.status, ["active", "retained", "pending_cleanup"])),
          )).limit(1);
          if (otherOwner) continue;
          await tx.update(environmentLeases).set({ status: "pending_cleanup", updatedAt: new Date() })
            .where(eq(environmentLeases.id, lease.id));
        }
        return run;
      });
      if (sourceRun) await sweepPendingCleanupLeases({ explicitRetry: {
        companyId, runId: sourceRun.id, actorId, reason: "queued_comment_interrupt",
      } });
    }
    const deliveryPayload = response ? { ...payload } : withQueuedCommentIdsInWakePayload(payload, commentIds);
    delete deliveryPayload.queuedCommentInterrupt;
    await enqueueWakeup(wake.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      payload: deliveryPayload, contextSnapshot: response
        ? { ...parseObject(payload._paperclipWakeContext), issueId, triggeredBy: "board", actorId,
            responsibleUserId: actorId }
        : withQueuedCommentIdsInRunContext({
            issueId, triggeredBy: "board", actorId, responsibleUserId: actorId,
          }, commentIds),
      requestedByActorType: "user", requestedByActorId: actorId,
      ...(interrupted ? { queuedCommentInterruptId: queueId } : { queuedCommentRequestId: queueId }),
      issueStateGuard: { assigneeAgentId: wake.agentId, statuses: ["todo", "in_progress", "in_review", "blocked"] },
      idempotencyKey: `queued-comment-${interrupted ? "interrupt" : "delivery"}:${queueId}`,
    }, queueId);
  }

  async function resumeExecutionWaitComments() {
    if ((await getSchedulingSuppression()).suppressed) return;
    const waits = await db.select({ wake: agentWakeupRequests })
      .from(agentWakeupRequests)
      .innerJoin(issues, and(eq(issues.companyId, agentWakeupRequests.companyId),
        sql`${issues.id}::text = ${agentWakeupRequests.payload}->>'issueId'`,
        eq(issues.assigneeAgentId, agentWakeupRequests.agentId)))
      .innerJoin(companies, and(eq(companies.id, issues.companyId), eq(companies.status, "active")))
      .where(and(exists(db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, issues.companyId), eq(issueRecoveryActions.sourceIssueId, issues.id),
        executionBlockerPredicate(),
      ))), eq(agentWakeupRequests.status, "deferred_issue_execution"),
        eq(agentWakeupRequests.requestedByActorType, "user"),
        sql`${agentWakeupRequests.payload}->'executionWait' is not null`,
        sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is null`,
        lte(agentWakeupRequests.updatedAt, new Date(Date.now() - 30_000)),
        notInArray(issues.status, ["done", "cancelled"])))
      .orderBy(asc(agentWakeupRequests.updatedAt)).limit(50);
    const seen = new Set<string>();
    for (const { wake } of waits) {
      const issueId = String(wake.payload?.issueId);
      if (seen.has(issueId)) continue;
      seen.add(issueId);
      // Advance the cursor even for invalid evidence so one damaged task cannot
      // starve later requests in this bounded scan. Preserve concurrent edits.
      const [claimed] = await db.update(agentWakeupRequests).set({ updatedAt: new Date() }).where(and(
        eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.companyId, wake.companyId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        lte(agentWakeupRequests.updatedAt, new Date(Date.now() - 30_000)),
      )).returning({ id: agentWakeupRequests.id });
      if (!claimed) continue;
      // Match normal admission's deterministic current blocker selection. An
      // arbitrary historical action must not choose the retry's source run.
      const blocker = await getExecutionBlocker(db, wake.companyId, issueId);
      const sourceId = blocker?.runId;
      if (!sourceId || !isUuidLike(sourceId)) continue;
      const run = await getRun(sourceId, { includeExecutionEvidence: true });
      if (!run || run.companyId !== wake.companyId || run.agentId !== wake.agentId) continue;
      if (canContinueCancelledRun(run)) {
        await resumeSavedLegacyComments(wake.companyId, wake.id).catch(err => {
          logger.warn({ err, runId: run.id }, "failed to resume saved input after provider cancellation");
        });
        continue;
      }
      await resumeRemoteStopComments(run, wake.id).catch(err => {
        logger.warn({ err, runId: run.id }, "failed to resume saved execution-wait message");
      });
    }
  }

  async function getAgentInvokability(
    agent: typeof agents.$inferSelect | null | undefined,
  ) {
    return evaluateAgentInvokabilityFromDb(db, agent);
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

  const issueMonitorDispatchColumns = {
    id: issues.id,
    companyId: issues.companyId,
    projectId: issues.projectId,
    goalId: issues.goalId,
    identifier: issues.identifier,
    title: issues.title,
    status: issues.status,
    priority: issues.priority,
    assigneeAgentId: issues.assigneeAgentId,
    assigneeUserId: issues.assigneeUserId,
    billingCode: issues.billingCode,
    executionPolicy: issues.executionPolicy,
    executionState: issues.executionState,
    monitorNextCheckAt: issues.monitorNextCheckAt,
    monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
    monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
    monitorAttemptCount: issues.monitorAttemptCount,
    monitorNotes: issues.monitorNotes,
    monitorScheduledBy: issues.monitorScheduledBy,
  };

  interface IssueMonitorDispatchRow {
    id: string;
    companyId: string;
    projectId: string | null;
    goalId: string | null;
    identifier: string | null;
    title: string;
    status: string;
    priority: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    billingCode: string | null;
    executionPolicy: Record<string, unknown> | null;
    executionState: Record<string, unknown> | null;
    monitorNextCheckAt: Date | null;
    monitorWakeRequestedAt: Date | null;
    monitorLastTriggeredAt: Date | null;
    monitorAttemptCount: number | null;
    monitorNotes: string | null;
    monitorScheduledBy: string | null;
  }

  function parseMonitorDate(value: string | null | undefined) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function issueMonitorLimitClearReason(input: {
    monitor: IssueExecutionMonitorPolicy | null;
    nextAttemptCount: number;
    now: Date;
  }): IssueExecutionMonitorClearReason | null {
    const timeoutAt = parseMonitorDate(input.monitor?.timeoutAt ?? null);
    if (timeoutAt && input.now.getTime() >= timeoutAt.getTime()) {
      return "timeout_exceeded";
    }
    const maxAttempts = input.monitor?.maxAttempts ?? null;
    if (maxAttempts !== null && input.nextAttemptCount > maxAttempts) {
      return "max_attempts_exhausted";
    }
    return null;
  }

  function monitorRecoveryPolicy(
    monitor: IssueExecutionMonitorPolicy | null,
  ): IssueExecutionMonitorRecoveryPolicy {
    return monitor?.recoveryPolicy ?? "wake_owner";
  }

  function monitorRecoveryDetails(input: {
    claimed: IssueMonitorDispatchRow;
    scheduledAtIso: string;
    nextAttemptCount: number;
    clearReason: IssueExecutionMonitorClearReason;
    recoveryPolicy: IssueExecutionMonitorRecoveryPolicy;
    monitor: IssueExecutionMonitorPolicy | null;
    source: "manual" | "scheduled";
  }) {
    return {
      identifier: input.claimed.identifier,
      nextCheckAt: input.scheduledAtIso,
      attemptedAttemptCount: input.nextAttemptCount,
      notes: input.claimed.monitorNotes ?? null,
      serviceName: input.monitor?.serviceName ?? null,
      timeoutAt: input.monitor?.timeoutAt ?? null,
      maxAttempts: input.monitor?.maxAttempts ?? null,
      clearReason: input.clearReason,
      recoveryPolicy: input.recoveryPolicy,
      source: input.source,
    };
  }

  function formatIssueIdentifierLink(
    identifier: string | null,
    fallback: string,
  ) {
    if (!identifier) return fallback;
    const prefix = identifier.split("-")[0];
    if (!prefix || !/^[A-Z][A-Z0-9]*-\d+$/.test(identifier)) return identifier;
    return `[${identifier}](/${prefix}/issues/${identifier})`;
  }

  function monitorRecoveryComment(input: {
    issue: IssueMonitorDispatchRow;
    clearReason: IssueExecutionMonitorClearReason;
    recoveryPolicy: IssueExecutionMonitorRecoveryPolicy;
    nextAttemptCount: number;
  }) {
    const label = formatIssueIdentifierLink(
      input.issue.identifier,
      input.issue.id,
    );
    const reason =
      input.clearReason === "timeout_exceeded"
        ? "its timeout was reached"
        : "its maximum attempt count was reached";
    return [
      `Paperclip cleared the scheduled external-service monitor for ${label} because ${reason}.`,
      "",
      `- Attempt count: ${input.nextAttemptCount}`,
      `- Recovery policy: ${input.recoveryPolicy}`,
      "",
      "Next action: inspect the external service state, record the result on this issue, and restore an explicit execution or waiting path if more work remains.",
    ].join("\n");
  }

  async function findOpenIssueMonitorRecoveryIssue(
    claimed: IssueMonitorDispatchRow,
  ) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, claimed.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.strandedIssueRecovery),
          eq(issues.originId, claimed.id),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function performIssueMonitorRecovery(input: {
    claimed: IssueMonitorDispatchRow;
    scheduledAtIso: string;
    nextAttemptCount: number;
    clearReason: IssueExecutionMonitorClearReason;
    recoveryPolicy: IssueExecutionMonitorRecoveryPolicy;
    monitor: IssueExecutionMonitorPolicy | null;
    actorType: "user" | "agent" | "system";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    activitySource: "manual" | "scheduled";
  }) {
    const reviewPathLost =
      input.claimed.status === "in_review" &&
      (await issuesSvc
        .listReviewAttention(input.claimed.companyId, [input.claimed])
        .then(
          (attention) => attention.get(input.claimed.id)?.state === "stalled",
        ));
    const reviewPathContext = reviewPathLost
      ? {
          reviewPathLost: true,
          reviewPathConsumedRef: `monitor:${input.claimed.id}:${input.clearReason}:${input.scheduledAtIso}`,
          reviewPathInstruction: REVIEW_PATH_RECOVERY_INSTRUCTION,
        }
      : null;
    const details = monitorRecoveryDetails({
      claimed: input.claimed,
      scheduledAtIso: input.scheduledAtIso,
      nextAttemptCount: input.nextAttemptCount,
      clearReason: input.clearReason,
      recoveryPolicy: input.recoveryPolicy,
      monitor: input.monitor,
      source: input.activitySource,
    });

    if (input.recoveryPolicy === "create_recovery_issue") {
      let recoveryIssue = await findOpenIssueMonitorRecoveryIssue(
        input.claimed,
      );
      if (!recoveryIssue) {
        recoveryIssue = await issuesSvc.create(input.claimed.companyId, {
          title: `Recover external-service monitor for ${input.claimed.identifier ?? input.claimed.title}`,
          description: monitorRecoveryComment({
            issue: input.claimed,
            clearReason: input.clearReason,
            recoveryPolicy: input.recoveryPolicy,
            nextAttemptCount: input.nextAttemptCount,
          }),
          status: "todo",
          priority: "high",
          parentId: input.claimed.id,
          projectId: input.claimed.projectId,
          goalId: input.claimed.goalId,
          assigneeAgentId: input.claimed.assigneeAgentId,
          originKind: RECOVERY_ORIGIN_KINDS.strandedIssueRecovery,
          originId: input.claimed.id,
          originFingerprint: `issue_monitor:${input.clearReason}`,
          billingCode: input.claimed.billingCode,
        });
      }

      if (recoveryIssue.assigneeAgentId) {
        await enqueueWakeup(recoveryIssue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_monitor_recovery_issue",
          idempotencyKey: `issue-monitor-recovery-issue:${input.claimed.id}:${input.clearReason}:${input.scheduledAtIso}`,
          payload: withRecoveryContext(
            { issueId: recoveryIssue.id, sourceIssueId: input.claimed.id },
            "status_only",
          ),
          requestedByActorType: input.actorType,
          requestedByActorId: input.actorId,
          contextSnapshot: withRecoveryContext(
            {
              issueId: recoveryIssue.id,
              sourceIssueId: input.claimed.id,
              source: "issue.monitor.recovery_issue",
              wakeReason: "issue_monitor_recovery_issue",
            },
            "status_only",
          ),
        });
      }

      await logActivity(db, {
        companyId: input.claimed.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId,
        runId: input.runId,
        action: "issue.monitor_recovery_issue_created",
        entityType: "issue",
        entityId: input.claimed.id,
        details: {
          ...details,
          recoveryIssueId: recoveryIssue.id,
          recoveryIdentifier: recoveryIssue.identifier,
        },
      });
      return;
    }

    if (input.recoveryPolicy === "escalate_to_board") {
      await db.insert(issueComments).values({
        companyId: input.claimed.companyId,
        issueId: input.claimed.id,
        body: monitorRecoveryComment({
          issue: input.claimed,
          clearReason: input.clearReason,
          recoveryPolicy: input.recoveryPolicy,
          nextAttemptCount: input.nextAttemptCount,
        }),
      });

      await logActivity(db, {
        companyId: input.claimed.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId,
        runId: input.runId,
        action: "issue.monitor_escalated_to_board",
        entityType: "issue",
        entityId: input.claimed.id,
        details,
      });
      return;
    }

    await enqueueWakeup(input.claimed.assigneeAgentId!, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_monitor_recovery",
      idempotencyKey: `issue-monitor-recovery:${input.claimed.id}:${input.clearReason}:${input.scheduledAtIso}`,
      payload: withRecoveryContext(
        {
          issueId: input.claimed.id,
          monitorAttemptCount: input.nextAttemptCount,
          monitorNotes: input.claimed.monitorNotes ?? null,
          clearReason: input.clearReason,
          serviceName: input.monitor?.serviceName ?? null,
          timeoutAt: input.monitor?.timeoutAt ?? null,
          maxAttempts: input.monitor?.maxAttempts ?? null,
          ...(reviewPathContext ?? {}),
        },
        "status_only",
      ),
      requestedByActorType: input.actorType,
      requestedByActorId: input.actorId,
      contextSnapshot: withRecoveryContext(
        {
          issueId: input.claimed.id,
          source: "issue.monitor.recovery",
          wakeReason: "issue_monitor_recovery",
          monitorAttemptCount: input.nextAttemptCount,
          monitorNotes: input.claimed.monitorNotes ?? null,
          clearReason: input.clearReason,
          serviceName: input.monitor?.serviceName ?? null,
          timeoutAt: input.monitor?.timeoutAt ?? null,
          maxAttempts: input.monitor?.maxAttempts ?? null,
          ...(reviewPathContext ?? {}),
        },
        "status_only",
      ),
    });

    await logActivity(db, {
      companyId: input.claimed.companyId,
      actorType: input.actorType,
      actorId: input.actorId,
      agentId: input.agentId,
      runId: input.runId,
      action: "issue.monitor_recovery_wake_queued",
      entityType: "issue",
      entityId: input.claimed.id,
      details,
    });
  }

  async function clearIssueMonitorAndRecover(input: {
    claimed: IssueMonitorDispatchRow;
    policy: ReturnType<typeof normalizeIssueExecutionPolicy>;
    scheduledAtIso: string;
    nextAttemptCount: number;
    clearReason: IssueExecutionMonitorClearReason;
    recoveryPolicy: IssueExecutionMonitorRecoveryPolicy;
    monitor: IssueExecutionMonitorPolicy | null;
    now: Date;
    actorType: "user" | "agent" | "system";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    activitySource: "manual" | "scheduled";
  }) {
    const cleared = await db
      .update(issues)
      .set({
        ...monitorOnlyDispatchPatch(buildIssueMonitorClearedPatch({
          issue: input.claimed,
          policy: input.policy,
          clearReason: input.clearReason,
          clearedAt: input.now,
        })),
        updatedAt: input.now,
      })
      .where(issueMonitorClaimCondition(input.claimed)).returning({ id: issues.id });
    if (cleared.length === 0) return { outcome: "skipped" as const, reason: "monitor_replaced" };

    await logActivity(db, {
      companyId: input.claimed.companyId,
      actorType: input.actorType,
      actorId: input.actorId,
      agentId: input.agentId,
      runId: input.runId,
      action: "issue.monitor_exhausted",
      entityType: "issue",
      entityId: input.claimed.id,
      details: monitorRecoveryDetails({
        claimed: input.claimed,
        scheduledAtIso: input.scheduledAtIso,
        nextAttemptCount: input.nextAttemptCount,
        clearReason: input.clearReason,
        recoveryPolicy: input.recoveryPolicy,
        monitor: input.monitor,
        source: input.activitySource,
      }),
    });

    await performIssueMonitorRecovery({
      claimed: input.claimed,
      scheduledAtIso: input.scheduledAtIso,
      nextAttemptCount: input.nextAttemptCount,
      clearReason: input.clearReason,
      recoveryPolicy: input.recoveryPolicy,
      monitor: input.monitor,
      actorType: input.actorType,
      actorId: input.actorId,
      agentId: input.agentId,
      runId: input.runId,
      activitySource: input.activitySource,
    });

    return { outcome: "skipped" as const, reason: input.clearReason };
  }

  function monitorOnlyDispatchPatch<T extends ReturnType<typeof buildIssueMonitorClearedPatch>>(patch: T) {
    // Admission and consumption are separate transactions. Preserve any review
    // policy/state changes made between them; only the monitor belongs to us.
    return {
      ...patch,
      executionPolicy: sql`nullif(${issues.executionPolicy} - 'monitor', '{}'::jsonb)`,
      executionState: sql`jsonb_set(coalesce(${issues.executionState}, ${JSON.stringify(patch.executionState)}::jsonb),
        '{monitor}', ${JSON.stringify(patch.executionState?.monitor ?? null)}::jsonb)`,
    };
  }

  function issueMonitorClaimCondition(claimed: IssueMonitorDispatchRow) {
    return and(eq(issues.id, claimed.id), eq(issues.companyId, claimed.companyId),
      eq(issues.assigneeAgentId, claimed.assigneeAgentId!), isNull(issues.assigneeUserId),
      eq(issues.status, claimed.status), eq(issues.monitorNextCheckAt, claimed.monitorNextCheckAt!),
      eq(issues.monitorWakeRequestedAt, claimed.monitorWakeRequestedAt!));
  }

  async function dispatchClaimedIssueMonitor(
    claimed: IssueMonitorDispatchRow,
    input: {
      now: Date;
      source: "automation" | "on_demand";
      triggerDetail: "manual" | "system";
      wakeReason: string;
      actorType: "user" | "agent" | "system";
      actorId: string;
      agentId: string | null;
      runId: string | null;
      clearOnClientError: boolean;
      activitySource: "manual" | "scheduled";
    },
  ) {
    if (!claimed.assigneeAgentId || !claimed.monitorNextCheckAt) {
      throw conflict("Issue monitor is not ready to dispatch");
    }

    const scheduledAtIso = claimed.monitorNextCheckAt.toISOString();
    const nextAttemptCount = (claimed.monitorAttemptCount ?? 0) + 1;
    const policy = normalizeIssueExecutionPolicy(
      claimed.executionPolicy ?? null,
    );
    const monitor = policy?.monitor ?? null;
    const clearReason = issueMonitorLimitClearReason({
      monitor,
      nextAttemptCount,
      now: input.now,
    });
    const recoveryPolicy = monitorRecoveryPolicy(monitor);
    const monitorMetadata = {
      serviceName: monitor?.serviceName ?? null,
      timeoutAt: monitor?.timeoutAt ?? null,
      maxAttempts: monitor?.maxAttempts ?? null,
      recoveryPolicy: monitor?.recoveryPolicy ?? null,
    };
    const executionState =
      claimed.status === "in_review"
        ? parseIssueExecutionState(claimed.executionState)
        : null;
    const currentParticipant =
      executionState?.status === "pending"
        ? executionState.currentParticipant
        : null;
    const reviewParticipantAgentId =
      currentParticipant?.type === "agent" ? currentParticipant.agentId : null;
    const isProviderQuotaReviewMonitor =
      monitor?.serviceName === PROVIDER_QUOTA_MONITOR_SERVICE_NAME &&
      Boolean(reviewParticipantAgentId);
    const targetAgentId = isProviderQuotaReviewMonitor
      ? reviewParticipantAgentId
      : claimed.assigneeAgentId;
    if (!targetAgentId) {
      throw conflict("Issue monitor has no agent target");
    }
    const wakeReason = isProviderQuotaReviewMonitor
      ? EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASON
      : input.wakeReason;
    const reviewRecoveryContext = isProviderQuotaReviewMonitor
      ? {
          retryReason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON,
          currentStageId: executionState?.currentStageId ?? null,
          currentStageType: executionState?.currentStageType ?? null,
          reviewRecoveryInstruction:
            "The previous reviewer run reached provider quota. Resume this execution-review stage now that the quota wait has elapsed.",
        }
      : {};

    if (clearReason) {
      return clearIssueMonitorAndRecover({
        claimed,
        policy,
        scheduledAtIso,
        nextAttemptCount,
        clearReason,
        recoveryPolicy,
        monitor,
        now: input.now,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId,
        runId: input.runId,
        activitySource: input.activitySource,
      });
    }

    try {
      if (monitor?.serviceName === PROVIDER_QUOTA_MONITOR_SERVICE_NAME) {
        // Normalized monitor projections redact externalRef. Read the claimed
        // persisted policy only on this server-owned quota recovery path.
        const sourceRunId = readNonEmptyString(
          parseObject(parseObject(claimed.executionPolicy).monitor).externalRef,
        );
        const sourceRun =
          sourceRunId && isUuidLike(sourceRunId)
            ? await getRun(sourceRunId, { unsafeFullResultJson: true })
            : null;
        if (
          !sourceRun ||
          sourceRun.companyId !== claimed.companyId ||
          sourceRun.agentId !== targetAgentId ||
          sourceRun.contextSnapshot?.issueId !== claimed.id ||
          !["failed", "timed_out", "interrupted", "cancelled"].includes(
            sourceRun.status,
          )
        ) {
          throw conflict(
            "The quota recovery source changed; inspect the current task execution.",
          );
        }
        if (sourceRun.runtimeMode === "native") {
          throw conflict(
            "Native execution recovery owns this provider failure; a quota monitor cannot start a replacement.",
          );
        }
        if (await legacyExecutionNeedsReconciliationWithEvidence(db, sourceRun)) {
          await terminalizeLegacyExecution({
            db,
            run: sourceRun,
            status: sourceRun.status,
          });
        } else {
          const targetAgent = await getAgent(targetAgentId);
          if (!targetAgent)
            throw conflict("The quota recovery agent is unavailable.");
          const scheduled = await scheduleBoundedRetryForRun(
            sourceRun,
            targetAgent,
            {
              now: input.now,
              ...(isProviderQuotaReviewMonitor
                ? {
                    retryReason:
                      EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON,
                    wakeReason:
                      EXECUTION_REVIEW_PARTICIPANT_RECOVERY_WAKE_REASON,
                  }
                : {}),
            },
          );
          if (scheduled.outcome === "not_scheduled")
            throw conflict(scheduled.reason);
        }
      } else {
        const wake = await enqueueWakeup(targetAgentId, {
          issueStateGuard: { statuses: [claimed.status], assigneeAgentId: claimed.assigneeAgentId,
            monitorNextCheckAt: scheduledAtIso, monitorWakeRequestedAt: claimed.monitorWakeRequestedAt!.toISOString() },
          source: input.source,
          triggerDetail: input.triggerDetail,
          reason: wakeReason,
          idempotencyKey: `issue-monitor:${claimed.id}:${scheduledAtIso}`,
          payload: {
            issueId: claimed.id,
            nextCheckAt: scheduledAtIso,
            monitorAttemptCount: nextAttemptCount,
            monitorNotes: claimed.monitorNotes ?? null,
            ...monitorMetadata,
            ...reviewRecoveryContext,
            source: input.activitySource,
          },
          requestedByActorType: input.actorType,
          requestedByActorId: input.actorId,
          contextSnapshot: {
            issueId: claimed.id,
            source: isProviderQuotaReviewMonitor
              ? "issue.execution_review_recovery"
              : "issue.monitor",
            wakeReason,
            nextCheckAt: scheduledAtIso,
            monitorAttemptCount: nextAttemptCount,
            monitorNotes: claimed.monitorNotes ?? null,
            ...monitorMetadata,
            ...reviewRecoveryContext,
            manualTrigger: input.activitySource === "manual",
          },
        });
        if (!wake) {
          await db.update(issues).set({ monitorWakeRequestedAt: null, updatedAt: input.now })
            .where(issueMonitorClaimCondition(claimed));
          return { outcome: "skipped" as const, reason: "monitor_dispatch_deferred" };
        }
      }

      const consumed = await db
        .update(issues)
        .set({
          ...monitorOnlyDispatchPatch(buildIssueMonitorTriggeredPatch({
            issue: claimed,
            policy,
            triggeredAt: input.now,
          })),
          updatedAt: new Date(),
        })
        .where(issueMonitorClaimCondition(claimed))
        .returning({ id: issues.id });
      if (consumed.length === 0) return { outcome: "skipped" as const, reason: "monitor_replaced" };

      await logActivity(db, {
        companyId: claimed.companyId,
        actorType: input.actorType,
        actorId: input.actorId,
        agentId: input.agentId,
        runId: input.runId,
        action: "issue.monitor_triggered",
        entityType: "issue",
        entityId: claimed.id,
        details: {
          identifier: claimed.identifier,
          nextCheckAt: scheduledAtIso,
          lastTriggeredAt: input.now.toISOString(),
          attemptCount: nextAttemptCount,
          notes: claimed.monitorNotes ?? null,
          ...monitorMetadata,
          source: input.activitySource,
        },
      });

      return { outcome: "triggered" as const };
    } catch (err) {
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) {
        if (input.clearOnClientError) {
          await db
            .update(issues)
            .set({
              ...monitorOnlyDispatchPatch(buildIssueMonitorClearedPatch({
                issue: claimed,
                policy,
                clearReason: "dispatch_skipped",
                clearedAt: input.now,
              })),
              updatedAt: new Date(),
            })
            .where(issueMonitorClaimCondition(claimed));

          await logActivity(db, {
            companyId: claimed.companyId,
            actorType: input.actorType,
            actorId: input.actorId,
            agentId: input.agentId,
            runId: input.runId,
            action: "issue.monitor_skipped",
            entityType: "issue",
            entityId: claimed.id,
            details: {
              identifier: claimed.identifier,
              nextCheckAt: scheduledAtIso,
              attemptCount: nextAttemptCount,
              notes: claimed.monitorNotes ?? null,
              reason: err.message,
              source: input.activitySource,
            },
          });

          return { outcome: "skipped" as const, reason: err.message };
        }

        await db
          .update(issues)
          .set({
            monitorWakeRequestedAt: null,
            updatedAt: new Date(),
          })
          .where(issueMonitorClaimCondition(claimed));
      } else {
        await db
          .update(issues)
          .set({
            monitorWakeRequestedAt: null,
            updatedAt: new Date(),
          })
          .where(issueMonitorClaimCondition(claimed));
      }

      throw err;
    }
  }

  function noActiveNativeMonitorRun() {
    return sql`not exists (select 1 from ${heartbeatRuns} monitor_run
      where monitor_run.company_id = ${issues.companyId}
        and monitor_run.native_issue_id = ${issues.id}
        and monitor_run.runtime_mode = 'native'
        and monitor_run.status in ('queued', 'running', 'scheduled_retry'))`;
  }

  async function triggerIssueMonitor(
    issueId: string,
    input?: {
      now?: Date;
      actorType?: "user" | "agent" | "system";
      actorId?: string | null;
      agentId?: string | null;
      runId?: string | null;
      wakeReason?: string;
    },
  ) {
    const now = input?.now ?? new Date();
    const actorType = input?.actorType ?? "system";
    const actorId =
      input?.actorId ?? (actorType === "system" ? "heartbeat_scheduler" : null);
    if (!actorId) {
      throw conflict("Issue monitor trigger requires an actor");
    }

    const issue = await db
      .select(issueMonitorDispatchColumns)
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!issue) {
      throw notFound("Issue not found");
    }
    if (!issue.monitorNextCheckAt) {
      throw conflict("Issue has no scheduled monitor");
    }
    if (!issue.assigneeAgentId || issue.assigneeUserId) {
      throw conflict("Issue monitor requires an agent assignee");
    }
    if (!["in_progress", "in_review"].includes(issue.status)) {
      throw conflict(
        "Issue monitor can only run while the issue is in progress or in review",
      );
    }

    const staleClaimThreshold = new Date(now.getTime() - 5 * 60 * 1000);
    const claimed = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(issues)
        .set({
          monitorWakeRequestedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.id, issueId),
            sql`${issues.monitorNextCheckAt} is not null`,
            isNull(issues.assigneeUserId),
            sql`${issues.assigneeAgentId} is not null`,
            inArray(issues.status, ["in_progress", "in_review"]),
            or(
              isNull(issues.monitorWakeRequestedAt),
              lt(issues.monitorWakeRequestedAt, staleClaimThreshold),
            ),
          ),
        )
        .returning();
      return (updated ?? null) as IssueMonitorDispatchRow | null;
    });

    if (!claimed) {
      throw conflict("Issue monitor check is already in progress");
    }

    return dispatchClaimedIssueMonitor(claimed, {
      now,
      source: "on_demand",
      triggerDetail: "manual",
      wakeReason: input?.wakeReason ?? "issue_monitor_due",
      actorType,
      actorId,
      agentId: input?.agentId ?? null,
      runId: input?.runId ?? null,
      clearOnClientError: false,
      activitySource: "manual",
    });
  }

  async function tickDueIssueMonitors(now = new Date()) {
    const staleClaimThreshold = new Date(now.getTime() - 5 * 60 * 1000);
    const dueMonitors = await db
      .select(issueMonitorDispatchColumns)
      .from(issues)
      .innerJoin(companies, eq(companies.id, issues.companyId))
      .where(
        and(
          eq(companies.status, "active"),
          noActiveNativeMonitorRun(),
          sql`${issues.monitorNextCheckAt} is not null`,
          lte(issues.monitorNextCheckAt, now),
          isNull(issues.assigneeUserId),
          sql`${issues.assigneeAgentId} is not null`,
          inArray(issues.status, ["in_progress", "in_review"]),
          or(
            isNull(issues.monitorWakeRequestedAt),
            lt(issues.monitorWakeRequestedAt, staleClaimThreshold),
          ),
        ),
      )
      .orderBy(asc(issues.monitorNextCheckAt), asc(issues.updatedAt))
      .limit(50);

    let triggered = 0;
    let skipped = 0;

    for (const due of dueMonitors) {
      const claimed = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(issues)
          .set({
            monitorWakeRequestedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.id, due.id),
              noActiveNativeMonitorRun(),
              sql`${issues.monitorNextCheckAt} is not null`,
              lte(issues.monitorNextCheckAt, now),
              isNull(issues.assigneeUserId),
              sql`${issues.assigneeAgentId} is not null`,
              inArray(issues.status, ["in_progress", "in_review"]),
              or(
                isNull(issues.monitorWakeRequestedAt),
                lt(issues.monitorWakeRequestedAt, staleClaimThreshold),
              ),
            ),
          )
          .returning();
        return (updated ?? null) as IssueMonitorDispatchRow | null;
      });

      if (!claimed) continue;

      try {
        const result = await dispatchClaimedIssueMonitor(claimed, {
          now,
          source: "automation",
          triggerDetail: "system",
          wakeReason: "issue_monitor_due",
          actorType: "system",
          actorId: "heartbeat_scheduler",
          agentId: null,
          runId: null,
          clearOnClientError: true,
          activitySource: "scheduled",
        });
        if (result.outcome === "triggered") triggered += 1;
        if (result.outcome === "skipped") skipped += 1;
      } catch (err) {
        logger.error({ err, issueId: claimed.id }, "issue monitor tick failed");
      }
    }

    return {
      checked: dueMonitors.length,
      triggered,
      skipped,
    };
  }

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
    const previousStatus = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

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
                activeIssueInteractionCondition(),
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
    meta: { pid: number; processGroupId: number | null; startedAt: string },
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

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    return {
      enabled: asBoolean(heartbeat.enabled, false),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      wakeOnDemand: isHeartbeatWakeOnDemandEnabled(agent),
      // A Dot binding has one external turn. Competing assignments must retain
      // their queue position instead of claiming a second run that cannot bind.
      maxConcurrentRuns: agent.adapterType === "paperclip_runner" &&
        parseObject(agent.adapterConfig).provider === "openai_dot"
        ? 1 : normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
      skipTimerWhenNoActionableWork: asBoolean(
        heartbeat.skipTimerWhenNoActionableWork ??
          heartbeat.requireActionableTimerWork ??
          heartbeat.issueOnlyTimer,
        false,
      ),
      maxDailyRuns: normalizeOptionalNonNegativeInteger(
        heartbeat.maxDailyRuns ??
          heartbeat.dailyRunLimit ??
          heartbeat.dailyRunCap ??
          heartbeat.maxRunsPerDay,
      ),
      maxDailyCostCents: normalizeOptionalNonNegativeInteger(
        heartbeat.maxDailyCostCents ??
          heartbeat.dailyCostCentsLimit ??
          heartbeat.dailySpendCentsLimit ??
          heartbeat.dailyBudgetCents,
      ),
    };
  }

  function normalizeOptionalNonNegativeInteger(value: unknown) {
    if (value === null || value === undefined || value === "") return null;
    const normalized = Math.floor(asNumber(value, 0));
    return normalized >= 0 ? normalized : null;
  }

  function currentUtcDayWindow(now = new Date()) {
    const start = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
    const end = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        0,
        0,
        0,
      ),
    );
    return { start, end };
  }

  async function getHeartbeatDailyCapBlock(
    agent: typeof agents.$inferSelect,
    policy: ReturnType<typeof parseHeartbeatPolicy>,
    options: {
      checkRunCap?: boolean;
      checkCostCap?: boolean;
      excludeRunId?: string | null;
    } = {},
    client: Pick<Db, "select"> = db,
  ) {
    const checkRunCap = options.checkRunCap ?? true;
    const checkCostCap = options.checkCostCap ?? true;
    const { start, end } = currentUtcDayWindow();
    if (checkRunCap && policy.maxDailyRuns !== null) {
      const conditions = [
        eq(heartbeatRuns.companyId, agent.companyId),
        eq(heartbeatRuns.agentId, agent.id),
        gte(heartbeatRuns.startedAt, start),
        lt(heartbeatRuns.startedAt, end),
        notInArray(heartbeatRuns.status, ["queued", "scheduled_retry"]),
      ];
      if (options.excludeRunId) {
        conditions.push(sql`${heartbeatRuns.id} <> ${options.excludeRunId}`);
      }
      const [row] = await client
        .select({ total: sql<number>`count(*)::integer` })
        .from(heartbeatRuns)
        .where(and(...conditions));
      const observed = Number(row?.total ?? 0);
      if (observed >= policy.maxDailyRuns) {
        return {
          reason: "heartbeat.daily_run_limit",
          observed,
          limit: policy.maxDailyRuns,
        };
      }
    }

    if (checkCostCap && policy.maxDailyCostCents !== null) {
      const [row] = await client
        .select({
          total: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, agent.companyId),
            eq(costEvents.agentId, agent.id),
            gte(costEvents.occurredAt, start),
            lt(costEvents.occurredAt, end),
          ),
        );
      const observed = Number(row?.total ?? 0);
      if (compareCents(String(row?.total ?? 0), policy.maxDailyCostCents) >= 0) {
        return {
          reason: "heartbeat.daily_cost_limit",
          observed,
          limit: policy.maxDailyCostCents,
        };
      }
    }

    return null;
  }

  async function cancelQueuedRunForHeartbeatDailyCap(
    run: typeof heartbeatRuns.$inferSelect,
    dailyCapBlock: NonNullable<
      Awaited<ReturnType<typeof getHeartbeatDailyCapBlock>>
    >,
  ) {
    const now = new Date();
    const reason =
      "Cancelled because the agent reached a per-day heartbeat budget cap before adapter invocation";
    const cancelled = await setRunStatus(run.id, "cancelled", {
      finishedAt: now,
      error: reason,
      errorCode: dailyCapBlock.reason,
      resultJson: {
        ...parseObject(run.resultJson),
        stopReason: dailyCapBlock.reason,
        observed: dailyCapBlock.observed,
        limit: dailyCapBlock.limit,
        effectiveTimeoutSec: 0,
        timeoutConfigured: false,
        timeoutSource: "heartbeat_daily_cap_gate",
        timeoutFired: false,
      },
    });
    if (!cancelled) return null;

    await setWakeupStatus(run.wakeupRequestId, "skipped", {
      finishedAt: now,
      error: reason,
    });

    await appendRunEvent(cancelled, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: reason,
      payload: {
        reason: dailyCapBlock.reason,
        observed: dailyCapBlock.observed,
        limit: dailyCapBlock.limit,
      },
    });

    await releaseIssueExecutionAndPromote(cancelled, {
      suppressImmediateRecovery: true,
    });

    return cancelled;
  }

  async function hasActionableTimerWork(agent: typeof agents.$inferSelect) {
    const row = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, agent.companyId),
          eq(issues.assigneeAgentId, agent.id),
          isNull(issues.assigneeUserId),
          isNull(issues.hiddenAt),
          inArray(issues.status, [...TIMER_ACTIONABLE_ISSUE_STATUSES]),
          isNull(issues.conversationAgentId),
          nonIdleSlackIssueCondition(),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function markTimerHeartbeatChecked(
    agentId: string,
    source: WakeupOptions["source"],
  ) {
    if (source !== "timer") return;
    await db
      .update(agents)
      .set({
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));
  }

  async function claimDueTimerHeartbeat(
    agent: typeof agents.$inferSelect,
    now: Date,
    intervalSec: number,
  ) {
    const dueBefore = new Date(now.getTime() - intervalSec * 1000);
    const claimed = await db
      .update(agents)
      .set({
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agents.id, agent.id),
          eq(agents.companyId, agent.companyId),
          or(
            lte(agents.lastHeartbeatAt, dueBefore),
            and(
              isNull(agents.lastHeartbeatAt),
              lte(agents.createdAt, dueBefore),
            ),
          ),
        ),
      )
      .returning({ id: agents.id })
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;
    return { wasFirstHeartbeat: !agent.lastHeartbeatAt };
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

  function issueRunPriorityRank(priority: string | null | undefined) {
    switch (priority) {
      case "critical":
        return 0;
      case "high":
        return 1;
      case "medium":
        return 2;
      case "low":
        return 3;
      default:
        return 4;
    }
  }

  async function listQueuedRunDependencyReadiness(
    companyId: string,
    queuedRuns: Array<typeof heartbeatRuns.$inferSelect>,
  ) {
    const issueIds = [
      ...new Set(
        queuedRuns
          .map((run) =>
            readNonEmptyString(parseObject(run.contextSnapshot).issueId),
          )
          .filter((issueId): issueId is string => Boolean(issueId)),
      ),
    ];
    if (issueIds.length === 0) {
      return new Map<
        string,
        Awaited<ReturnType<typeof issuesSvc.getDependencyReadiness>>
      >();
    }
    return issuesSvc.listDependencyReadiness(companyId, issueIds);
  }

  async function countRunningRunsForAgent(agentId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.status, "running"),
        ),
      );
    return Number(count ?? 0);
  }

  async function withChatControlRecoveryGate(
    run: typeof heartbeatRuns.$inferSelect,
    stage: "claim" | "dispatch",
    onClear: (tx: Db) => Promise<typeof heartbeatRuns.$inferSelect | null>,
    nativeRecovery = false,
  ) {
    const issueId = readNonEmptyString(
      parseObject(run.contextSnapshot).issueId,
    );
    if (!issueId || run.invocationSource !== "automation") return onClear(db);
    await options.beforeChatControlRecoveryCheck?.({
      runId: run.id,
      issueId,
      stage,
    });
    if (stage === "dispatch" && nativeRecovery) {
      // Protected historical/already-admitted owners did not previously take
      // this fence's locks. A fresh exact read keeps unrelated Board contention
      // from turning their recovery into a new admission failure.
      const [current] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.companyId, run.companyId),
            eq(heartbeatRuns.agentId, run.agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .limit(1);
      if (
        current &&
        current.wakeupRequestId === run.wakeupRequestId &&
        parseObject(current.contextSnapshot).issueId === issueId
      ) {
        const admission = readChatControlRecoveryAdmission(current);
        const expected = readChatControlRecoveryAdmission(run);
        if (
          expected !== "invalid" &&
          (admission === "admitted" ||
            (admission === "historical" && expected === "historical"))
        )
          return onClear(db);
      }
    }
    let terminal: typeof heartbeatRuns.$inferSelect | null = null;
    try {
      const attempt = () => db.transaction(async (tx) => {
        terminal = null;
        // Same queue-edit lock order, then the close committer's conversation
        // row. NOWAIT releases partial locks on contention. Claim defers to the
        // queue; dispatch retries this transaction before considering failure.
        const [issue] = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)),
          )
          .for("update", { noWait: true })
          .limit(1);
        if (!issue) return null;
        if (run.wakeupRequestId)
          await tx
            .select({ id: agentWakeupRequests.id })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.id, run.wakeupRequestId),
                eq(agentWakeupRequests.companyId, run.companyId),
                eq(agentWakeupRequests.agentId, run.agentId),
              ),
            )
            .for("update", { noWait: true })
            .limit(1);
        const [current] = await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, run.id),
              eq(heartbeatRuns.companyId, run.companyId),
              eq(heartbeatRuns.agentId, run.agentId),
            ),
          )
          .for("update", { noWait: true })
          .limit(1);
        if (
          !current ||
          current.status !== (stage === "claim" ? "queued" : "running")
        )
          return null;
        const admission = readChatControlRecoveryAdmission(current);
        const expectedAdmission = readChatControlRecoveryAdmission(run);
        const admissionLost =
          expectedAdmission !== "historical" && admission === "historical";
        if (
          stage === "dispatch" &&
          nativeRecovery &&
          !admissionLost &&
          (admission === "historical" || admission === "admitted")
        )
          return onClear(tx as unknown as Db);
        // A new warm child can inherit a prior runner's PID during preparation.
        // Those fields do not prove this run's turn was dispatched.
        // Exact admitted/historical recovery retains its existing ownership;
        // a marked, unadmitted bootstrap must earn admission even after crash.
        const proof =
          admission === "invalid" || admissionLost
            ? { kind: "unresolved" as const }
            : await readChatControlRecoveryStop(
                tx as unknown as Db,
                {
                  companyId: run.companyId,
                  issueId,
                  agentId: run.agentId,
                  sourceRunId: run.id,
                },
                true,
              );
        if (proof.kind === "clear") {
          if (stage === "claim" || admission === "required")
            await tx
              .update(heartbeatRuns)
              .set({
                runnerProfileJson: {
                  ...parseObject(current.runnerProfileJson),
                  [CHAT_CONTROL_RECOVERY_ADMISSION_KEY]:
                    chatControlRecoveryAdmission(
                      current,
                      stage === "dispatch"
                        ? "admitted"
                        : admission === "admitted"
                          ? "admitted"
                          : "required",
                    ),
                },
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, current.id));
          return onClear(tx as unknown as Db);
        }
        if (proof.kind === "unresolved" && stage === "claim") return null;
        const now = new Date();
        const stopped = proof.kind === "stopped";
        const code = stopped
          ? CHAT_CONTROL_RECOVERY_STOP_CODE
          : CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE;
        const error = stopped
          ? "Automatic continuation stopped by the committed chat conversation close. Send a new request in chat or on the Board to start fresh work."
          : "Automatic continuation source could not be verified before provider admission. Review the task and send a fresh request; this attempt will not automatically retry.";
        [terminal] = await tx
          .update(heartbeatRuns)
          .set({
            status: stopped ? "cancelled" : "failed",
            errorCode: code,
            error,
            finishedAt: now,
            resultJson: {
              ...parseObject(current.resultJson),
              automaticRecovery: {
                code,
                providerDispatched: false,
                ...(stopped
                  ? {
                      sourceRunId: proof.sourceRunId,
                      conversationId: proof.conversationId,
                      publicationId: proof.publicationId,
                    }
                  : {}),
              },
            },
            updatedAt: now,
          })
          .where(
            and(
              eq(heartbeatRuns.id, current.id),
              eq(heartbeatRuns.status, current.status),
            ),
          )
          .returning();
        if (!terminal) return null;
        if (current.wakeupRequestId)
          await tx
            .update(agentWakeupRequests)
            .set({
              status: stopped ? "skipped" : "failed",
              error,
              finishedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(agentWakeupRequests.id, current.wakeupRequestId),
                eq(agentWakeupRequests.companyId, current.companyId),
                eq(agentWakeupRequests.agentId, current.agentId),
                eq(agentWakeupRequests.runId, current.id),
                ne(agentWakeupRequests.status, "cancelled"),
              ),
            );
        await tx
          .update(issues)
          .set({
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.companyId, current.companyId),
              eq(issues.id, issueId),
              eq(issues.executionRunId, current.id),
            ),
          );
        return null;
      });
      const result = stage === "dispatch"
        ? await retryChatControlAdmission(attempt)
        : await attempt();
      if (terminal) {
        const settled = terminal as typeof heartbeatRuns.$inferSelect;
        publishLiveEvent({
          companyId: settled.companyId,
          type: "heartbeat.run.status",
          payload: {
            runId: settled.id,
            agentId: settled.agentId,
            status: settled.status,
            errorCode: settled.errorCode,
            error: settled.error,
          },
        });
        publishRunLifecyclePluginEvent(settled);
        if (stage === "dispatch")
          await finalizeAgentStatus(settled.agentId, "cancelled");
      }
      return result;
    } catch (error) {
      if (!isExternalChatWaitAuthorizationContention(error)) throw error;
      if (stage === "dispatch") {
        // No effect was admitted. Let the existing setup-failure path settle
        // this attempt distinctly; it must not become a successful close.
        throw new ChatControlRecoveryUnresolvedError();
      }
      return null;
    }
  }

  async function claimQueuedRun(
    run: typeof heartbeatRuns.$inferSelect,
    companyAgents?: AgentOrgRow[],
  ) {
    if (run.status !== "queued") return run;
    const agent = await getAgent(run.agentId);
    if (!agent) {
      await cancelRunInternal(
        run.id,
        "Cancelled because the agent no longer exists",
      );
      return null;
    }
    const invokability = companyAgents
      ? evaluateAgentInvokability(toAgentOrgRow(agent), companyAgents)
      : await getAgentInvokability(agent);
    if (!invokability.invokable) {
      await cancelRunInternal(
        run.id,
        `Cancelled because the agent is not invokable: ${invokability.reason}`,
      );
      return null;
    }

    const context = parseObject(run.contextSnapshot);
    const budgetBlock = await budgets.getInvocationBlock(
      run.companyId,
      run.agentId,
      {
        issueId: readNonEmptyString(context.issueId),
        projectId: readNonEmptyString(context.projectId),
      },
    );
    if (budgetBlock) {
      await cancelRunInternal(run.id, budgetBlock.reason);
      return null;
    }

    const dailyCapBlock = await getHeartbeatDailyCapBlock(
      agent,
      parseHeartbeatPolicy(agent),
      {
        excludeRunId: run.id,
        checkRunCap: true,
        checkCostCap: true,
      },
    );
    if (dailyCapBlock) {
      await cancelQueuedRunForHeartbeatDailyCap(run, dailyCapBlock);
      return null;
    }

    const issueId = readNonEmptyString(context.issueId);
    if (issueId && activeRunExecutions.size > 0) {
      // Native finalization publishes success before workspace synchronization,
      // provider suspension, and lease release finish. A queued comment must
      // not acquire a fresh sandbox while its predecessor still owns that work.
      // The executor's finally block retries this agent after removing its owner.
      const [settlingOwner] = await db.select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, run.companyId),
          eq(heartbeatRuns.agentId, run.agentId),
          eq(heartbeatRuns.runtimeMode, "native"),
          inArray(heartbeatRuns.id, [...activeRunExecutions]),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
        ))
        .limit(1);
      if (settlingOwner) return null;
    }
    if (issueId) {
      const activePauseHold = await treeControlSvc.getActivePauseHoldGate(
        run.companyId,
        issueId,
      );
      const treeHoldInteractionWake =
        activePauseHold &&
        (await isVerifiedIssueTreeControlInteractionWake(db, {
          companyId: run.companyId,
          issueId,
          agentId: run.agentId,
          runId: run.id,
          wakeupRequestId: run.wakeupRequestId,
          contextSnapshot: context,
        }));
      if (activePauseHold && !treeHoldInteractionWake) {
        await cancelRunInternal(
          run.id,
          "Cancelled because issue is held by an active subtree pause hold",
        );
        await logActivity(db, {
          companyId: run.companyId,
          actorType: "system",
          actorId: "system",
          agentId: run.agentId,
          runId: run.id,
          action: "issue.tree_hold_run_interrupted",
          entityType: "heartbeat_run",
          entityId: run.id,
          issueId: issueId,
          details: {
            issueId,
            holdId: activePauseHold.holdId,
            rootIssueId: activePauseHold.rootIssueId,
            source: "heartbeat.claim_queued_run",
            securityPrinciples: [
              "Complete Mediation",
              "Fail Securely",
              "Secure Defaults",
            ],
          },
        });
        return null;
      }

      const dependencyReadiness = await issuesSvc.listDependencyReadiness(
        run.companyId,
        [issueId],
      );
      const readiness = dependencyReadiness.get(issueId);
      const unresolvedBlockerCount = readiness?.unresolvedBlockerCount ?? 0;
      if (
        unresolvedBlockerCount > 0 &&
        !allowsIssueInteractionWake(
          context,
          ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
        )
      ) {
        await cancelQueuedRunForBlockedDependencies(
          run,
          issueId,
          readiness?.unresolvedBlockerIssueIds ?? [],
        );
        logger.info(
          { runId: run.id, issueId, unresolvedBlockerCount },
          "claimQueuedRun: cancelled blocked queued run",
        );
        return null;
      }

      const staleness = await runDispatch.cancelStaleQueuedRun({
        runId: run.id,
        companyId: run.companyId,
        expectedStatus: "queued",
      });
      if (staleness.outcome === "cancelled" || staleness.outcome === "deferred") {
        applyRunDispatchPostCommitEffects(staleness.postCommitEffects);
        logger.info(
          {
            runId: run.id,
            issueId,
            outcome: staleness.outcome,
            errorCode: staleness.outcome === "cancelled" ? staleness.errorCode : undefined,
          },
          "claimQueuedRun: withheld queued run at the execution gate",
        );
        return null;
      }
    }

    const claimedAt = new Date();
    const responsibleUserId = await resolveResponsibleUserIdForRun({
      run,
      contextSnapshot: context,
      issueContext: issueId
        ? await getIssueExecutionContext(run.companyId, issueId)
        : null,
      routineEnvContext: {
        routineId: null,
        env: null,
        responsibleUserId: null,
      },
    });
    // All ordinary and comment claims use the same company-scoped issue
    // lock. A batch may claim several runs before executeRun tracks any owner.
    async function lockIssueExecutionClaim(tx: Db) {
      const [owner] = issueId ? await tx.select({
        assigneeAgentId: issues.assigneeAgentId,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
      }).from(issues).where(and(
        eq(issues.id, issueId), eq(issues.companyId, run.companyId),
      )).for("update") : [];
      const ownsIssue = owner?.assigneeAgentId === run.agentId &&
        context.wakeReason !== "source_scoped_recovery_action";
      if (ownsIssue && ["native_safe_replacement", "native_provider_overloaded"].includes(run.scheduledRetryReason ?? "") &&
          owner.checkoutRunId && owner.checkoutRunId !== run.id) {
        return { ownsIssue, blocked: true };
      }
      if (run.scheduledRetryReason === "native_provider_overloaded" && owner?.executionRunId &&
          owner.executionRunId !== run.id && owner.executionRunId !== run.retryOfRunId) {
        return { ownsIssue, blocked: true };
      }
      const previousRunId = run.scheduledRetryReason === "native_provider_overloaded"
        ? run.retryOfRunId : ownsIssue ? owner?.executionRunId : null;
      if (previousRunId && previousRunId !== run.id) {
        const [previous] = await tx.select({ status: heartbeatRuns.status })
          .from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, previousRunId),
            eq(heartbeatRuns.companyId, run.companyId),
          ));
        // A terminal result can precede workspace/lease cleanup on this or
        // another controller. Local absence alone is not a release receipt.
        if (!isHeartbeatRunTerminalStatus(previous?.status) ||
            liveRunExecutions.has(previousRunId)) {
          return { ownsIssue, blocked: true };
        }
        const [pendingLease] = await tx.select({ id: environmentLeases.id })
          .from(environmentLeases).where(and(
            eq(environmentLeases.companyId, run.companyId),
            eq(environmentLeases.heartbeatRunId, previousRunId),
            or(and(isNull(environmentLeases.releasedAt),
                // Warm release deliberately retains the sandbox. Its successful
                // receipt settles the old run without destroying the resource.
                sql`not coalesce(${environmentLeases.status} = 'retained'
                  and ${environmentLeases.leasePolicy} = 'reuse_by_environment'
                  and ${environmentLeases.cleanupStatus} = 'success', false)`),
              eq(environmentLeases.status, "pending_cleanup"),
              eq(environmentLeases.cleanupStatus, "failed")),
          )).limit(1);
        const [finalization] = await tx.select({
          phase: nativeRunFinalizations.phase, leaseOwner: nativeRunFinalizations.leaseOwner,
        }).from(nativeRunFinalizations).where(and(
          eq(nativeRunFinalizations.companyId, run.companyId),
          eq(nativeRunFinalizations.runId, previousRunId),
        ));
        if (pendingLease || (finalization && (finalization.leaseOwner ||
            !["committed", "applied", "terminal_failure"].includes(finalization.phase)))) {
          return { ownsIssue, blocked: true };
        }
      }
      return { ownsIssue, blocked: false };
    }
    async function bindClaimedIssueExecution(tx: Db, ownsIssue: boolean, claimedRun: typeof heartbeatRuns.$inferSelect | null | undefined) {
      if (!claimedRun || !issueId || !ownsIssue) return;
      await tx.update(issues).set({
        executionRunId: claimedRun.id,
        executionAgentNameKey: normalizeAgentNameKey(agent.name),
        executionLockedAt: claimedAt,
        updatedAt: claimedAt,
      }).where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)));
    }
    const nativeReviewContext = readNativeReviewAssignmentContext(context);
    const queuedCommentIds = queuedCommentIdsFromRunContext(context);
    if (
      issueId &&
      run.invocationSource === "automation" &&
      queuedCommentIds.length > 0
    )
      await options.beforeChatControlRecoveryCheck?.({
        runId: run.id,
        issueId,
        stage: "claim",
      });
    const queuedCommentClaim =
      !nativeReviewContext && issueId && run.wakeupRequestId && queuedCommentIds.length > 0
        ? await db
            .transaction(async (tx) => {
              // Match the queue-edit lock order: issue, wake, then run. Once the
              // run becomes running, a concurrent discard must observe the
              // claimed wake and return an explicit conflict; if discard wins,
              // this claim observes the cancelled queue and does no work.
              const issueClaim = await lockIssueExecutionClaim(tx as unknown as Db);
              if (issueClaim.blocked) return { kind: "stale" as const, run: null };
              const wake = await tx
                .select()
                .from(agentWakeupRequests)
                .where(
                  and(
                    eq(agentWakeupRequests.id, run.wakeupRequestId!),
                    eq(agentWakeupRequests.companyId, run.companyId),
                    eq(agentWakeupRequests.agentId, run.agentId),
                  ),
                )
                .for("update")
                .limit(1)
                .then((rows) => rows[0] ?? null);
              const lockedRun = await tx
                .select()
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.id, run.id),
                    eq(heartbeatRuns.companyId, run.companyId),
                    eq(heartbeatRuns.agentId, run.agentId),
                  ),
                )
                .for("update")
                .limit(1)
                .then((rows) => rows[0] ?? null);
              if (
                !wake ||
                wake.status !== "queued" ||
                wake.runId !== run.id ||
                !lockedRun ||
                lockedRun.status !== "queued" ||
                lockedRun.wakeupRequestId !== wake.id
              ) {
                return { kind: "stale" as const, run: null };
              }

              if (lockedRun.invocationSource === "automation") {
                const admission = readChatControlRecoveryAdmission(lockedRun);
                if (admission === "invalid")
                  return { kind: "stale" as const, run: null };
                const proof = await readChatControlRecoveryStop(
                  tx as unknown as Db,
                  {
                    companyId: lockedRun.companyId,
                    issueId,
                    agentId: lockedRun.agentId,
                    sourceRunId: lockedRun.id,
                  },
                  true,
                );
                if (proof.kind === "unresolved")
                  return { kind: "stale" as const, run: null };
                if (proof.kind === "stopped") {
                  const error =
                    "Automatic continuation stopped by the committed chat conversation close. Send a fresh request in chat or on the Board.";
                  const [cancelled] = await tx
                    .update(heartbeatRuns)
                    .set({
                      status: "cancelled",
                      errorCode: CHAT_CONTROL_RECOVERY_STOP_CODE,
                      error,
                      finishedAt: claimedAt,
                      resultJson: {
                        ...parseObject(lockedRun.resultJson),
                        automaticRecovery: {
                          code: CHAT_CONTROL_RECOVERY_STOP_CODE,
                          providerDispatched: false,
                          sourceRunId: proof.sourceRunId,
                          conversationId: proof.conversationId,
                          publicationId: proof.publicationId,
                        },
                      },
                      updatedAt: claimedAt,
                    })
                    .where(
                      and(
                        eq(heartbeatRuns.id, lockedRun.id),
                        eq(heartbeatRuns.status, "queued"),
                      ),
                    )
                    .returning();
                  if (!cancelled) return { kind: "stale" as const, run: null };
                  await tx
                    .update(agentWakeupRequests)
                    .set({
                      status: "skipped",
                      error,
                      finishedAt: claimedAt,
                      updatedAt: claimedAt,
                    })
                    .where(eq(agentWakeupRequests.id, wake.id));
                  await tx
                    .update(issues)
                    .set({
                      executionRunId: null,
                      executionAgentNameKey: null,
                      executionLockedAt: null,
                      updatedAt: claimedAt,
                    })
                    .where(
                      and(
                        eq(issues.id, issueId),
                        eq(issues.companyId, run.companyId),
                        eq(issues.executionRunId, run.id),
                      ),
                    );
                  return { kind: "cancelled" as const, run: cancelled };
                }
                await tx
                  .update(heartbeatRuns)
                  .set({
                    runnerProfileJson: {
                      ...parseObject(lockedRun.runnerProfileJson),
                      [CHAT_CONTROL_RECOVERY_ADMISSION_KEY]:
                        chatControlRecoveryAdmission(
                          lockedRun,
                          admission === "admitted" ? "admitted" : "required",
                        ),
                    },
                    updatedAt: claimedAt,
                  })
                  .where(eq(heartbeatRuns.id, lockedRun.id));
              }
              const authoritativeIds = queuedCommentIdsFromWakePayload(
                wake.payload,
              );
              if (authoritativeIds.length === 0) {
                // Legacy/direct comment wakes carry comment ids in their ordinary
                // payload and context, not in the authoritative queued-message
                // envelope. Preserve their established claim path; only an
                // explicitly bound queued-message envelope is subject to the
                // live-comment discard gate below.
                const [claimedRun] = await tx
                  .update(heartbeatRuns)
                  .set({
                    status: "running",
                    runnerProfileJson: sql`(case when jsonb_typeof(${heartbeatRuns.runnerProfileJson}) = 'object' then ${heartbeatRuns.runnerProfileJson} else '{}'::jsonb end) || ${JSON.stringify({ adapterDispatch: { adapterType: agent.adapterType } })}::jsonb`,
                    ...legacyControllerClaim(run.runtimeMode),
                    responsibleUserId,
                    startedAt: lockedRun.startedAt ?? claimedAt,
                    updatedAt: claimedAt,
                  })
                  .where(
                    and(
                      eq(heartbeatRuns.id, lockedRun.id),
                      eq(heartbeatRuns.status, "queued"),
                    ),
                  )
                  .returning();
                await bindClaimedIssueExecution(tx as unknown as Db, issueClaim.ownsIssue, claimedRun);
                return claimedRun
                  ? { kind: "claimed" as const, run: claimedRun }
                  : { kind: "stale" as const, run: null };
              }
              const commentRows = await tx
                .select({
                  id: issueComments.id,
                  deletedAt: issueComments.deletedAt,
                })
                .from(issueComments)
                .where(
                  and(
                    eq(issueComments.companyId, run.companyId),
                    eq(issueComments.issueId, issueId),
                    inArray(issueComments.id, authoritativeIds),
                  ),
                );
              const liveIds = authoritativeIds.filter((commentId) => {
                const comment = commentRows.find((row) => row.id === commentId);
                return Boolean(comment && !comment.deletedAt);
              });
              if (liveIds.length === 0) {
                const reason = "Queued messages were discarded before dispatch";
                const [cancelled] = await tx
                  .update(heartbeatRuns)
                  .set({
                    status: "cancelled",
                    finishedAt: claimedAt,
                    error: reason,
                    errorCode: "queued_comment_discarded",
                    updatedAt: claimedAt,
                  })
                  .where(
                    and(
                      eq(heartbeatRuns.id, lockedRun.id),
                      eq(heartbeatRuns.status, "queued"),
                    ),
                  )
                  .returning();
                await tx
                  .update(agentWakeupRequests)
                  .set({
                    status: "cancelled",
                    finishedAt: claimedAt,
                    error: reason,
                    updatedAt: claimedAt,
                  })
                  .where(eq(agentWakeupRequests.id, wake.id));
                await tx
                  .update(issues)
                  .set({
                    executionRunId: null,
                    executionAgentNameKey: null,
                    executionLockedAt: null,
                    updatedAt: claimedAt,
                  })
                  .where(
                    and(
                      eq(issues.id, issueId),
                      eq(issues.companyId, run.companyId),
                      eq(issues.executionRunId, run.id),
                    ),
                  );
                return {
                  kind: "cancelled" as const,
                  run: cancelled ?? lockedRun,
                };
              }

              await tx
                .update(agentWakeupRequests)
                .set({
                  status: "claimed",
                  claimedAt,
                  payload: withQueuedCommentIdsInWakePayload(
                    wake.payload,
                    liveIds,
                  ),
                  updatedAt: claimedAt,
                })
                .where(eq(agentWakeupRequests.id, wake.id));
              const [claimedRun] = await tx
                .update(heartbeatRuns)
                .set({
                  status: "running",
                  runnerProfileJson: sql`(case when jsonb_typeof(${heartbeatRuns.runnerProfileJson}) = 'object' then ${heartbeatRuns.runnerProfileJson} else '{}'::jsonb end) || ${JSON.stringify({ adapterDispatch: { adapterType: agent.adapterType } })}::jsonb`,
                    ...legacyControllerClaim(run.runtimeMode),
                  responsibleUserId,
                  startedAt: lockedRun.startedAt ?? claimedAt,
                  contextSnapshot: withQueuedCommentIdsInRunContext(
                    lockedRun.contextSnapshot,
                    liveIds,
                  ),
                  updatedAt: claimedAt,
                })
                .where(
                  and(
                    eq(heartbeatRuns.id, lockedRun.id),
                    eq(heartbeatRuns.status, "queued"),
                  ),
                )
                .returning();
              await bindClaimedIssueExecution(tx as unknown as Db, issueClaim.ownsIssue, claimedRun);
              return claimedRun
                ? { kind: "claimed" as const, run: claimedRun }
                : { kind: "stale" as const, run: null };
            })
            .catch((error) => {
              if (isExternalChatWaitAuthorizationContention(error))
                return { kind: "stale" as const, run: null };
              throw error;
            })
        : null;
    if (queuedCommentClaim?.kind === "cancelled") {
      await appendRunEvent(queuedCommentClaim.run, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message:
          queuedCommentClaim.run.error ??
          "Queued messages were discarded before dispatch",
      });
      publishLiveEvent({
        companyId: queuedCommentClaim.run.companyId,
        type: "heartbeat.run.status",
        payload: {
          runId: queuedCommentClaim.run.id,
          agentId: queuedCommentClaim.run.agentId,
          status: queuedCommentClaim.run.status,
          invocationSource: queuedCommentClaim.run.invocationSource,
          triggerDetail: queuedCommentClaim.run.triggerDetail,
          error: queuedCommentClaim.run.error ?? null,
          errorCode: queuedCommentClaim.run.errorCode ?? null,
          startedAt: queuedCommentClaim.run.startedAt
            ? new Date(queuedCommentClaim.run.startedAt).toISOString()
            : null,
          finishedAt: queuedCommentClaim.run.finishedAt
            ? new Date(queuedCommentClaim.run.finishedAt).toISOString()
            : null,
        },
      });
      publishRunLifecyclePluginEvent(queuedCommentClaim.run);
      // Fire-and-forget: nothing else in this path depends on the emission,
      // so it must not delay the return.
      void emitAgentTaskRun(db, queuedCommentClaim.run);
      return null;
    }
    const claimed = queuedCommentClaim
      ? queuedCommentClaim.run
      : await withChatControlRecoveryGate(run, "claim", async (tx) => {
          const claimValues = {
            status: "running",
            runnerProfileJson: sql`(case when jsonb_typeof(${heartbeatRuns.runnerProfileJson}) = 'object' then ${heartbeatRuns.runnerProfileJson} else '{}'::jsonb end) || ${JSON.stringify({ adapterDispatch: { adapterType: agent.adapterType } })}::jsonb`,
            ...legacyControllerClaim(run.runtimeMode),
            responsibleUserId,
            startedAt: run.startedAt ?? claimedAt,
            updatedAt: claimedAt,
          };
          if (nativeReviewContext) {
            if (run.scheduledRetryReason === "native_provider_overloaded") {
              const predecessor = await lockIssueExecutionClaim(tx);
              if (predecessor.blocked) return null;
            }
            return claimQueuedNativeReviewRun(tx, {
              run, claimedAt, claimValues,
              agentNameKey: normalizeAgentNameKey(agent.name),
            });
          }
          return tx.transaction(async (claimTx) => {
            const issueClaim = await lockIssueExecutionClaim(claimTx as unknown as Db);
            if (issueClaim.blocked) return null;
            const claimedRun = await claimTx.update(heartbeatRuns).set(claimValues).where(and(
              eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued"),
            )).returning().then((rows) => rows[0] ?? null);
            await bindClaimedIssueExecution(claimTx as unknown as Db, issueClaim.ownsIssue, claimedRun);
            return claimedRun;
          });
        });
    if (!claimed) return null;

    publishLiveEvent({
      companyId: claimed.companyId,
      type: "heartbeat.run.status",
      payload: {
        runId: claimed.id,
        agentId: claimed.agentId,
        status: claimed.status,
        invocationSource: claimed.invocationSource,
        triggerDetail: claimed.triggerDetail,
        error: claimed.error ?? null,
        errorCode: claimed.errorCode ?? null,
        startedAt: claimed.startedAt
          ? new Date(claimed.startedAt).toISOString()
          : null,
        finishedAt: claimed.finishedAt
          ? new Date(claimed.finishedAt).toISOString()
          : null,
      },
    });
    publishRunLifecyclePluginEvent(claimed);

    if (!nativeReviewContext) {
      await setWakeupStatus(claimed.wakeupRequestId, "claimed", { claimedAt });
    }

    // Fix A (lazy locking): stamp executionRunId now that the run is actually running,
    // not at queue time. Guard is idempotent — safe if called more than once.
    const claimedContext = parseObject(claimed.contextSnapshot);
    const claimedIssueId = readNonEmptyString(claimedContext.issueId);
    const claimedWakeReason = readNonEmptyString(claimedContext.wakeReason);
    if (
      !nativeReviewContext && claimedIssueId &&
      claimedWakeReason !== "source_scoped_recovery_action"
    ) {
      const claimedAgent = await getAgent(claimed.agentId);
      await db
        .update(issues)
        .set({
          executionRunId: claimed.id,
          executionAgentNameKey: normalizeAgentNameKey(claimedAgent?.name),
          executionLockedAt: claimedAt,
          updatedAt: claimedAt,
        })
        .where(
          and(
            eq(issues.id, claimedIssueId),
            eq(issues.companyId, claimed.companyId),
            // Mention/context runs can touch an issue, but only the current assignee
            // owns the issue execution lock shown as the active run.
            eq(issues.assigneeAgentId, claimed.agentId),
            ["native_safe_replacement", "native_provider_overloaded"].includes(claimed.scheduledRetryReason ?? "")
              ? or(
                  isNull(issues.checkoutRunId),
                  eq(issues.checkoutRunId, claimed.id),
                )
              : undefined,
            or(
              isNull(issues.executionRunId),
              eq(issues.executionRunId, claimed.id),
            ),
          ),
        );
    }

    return claimed;
  }

  // startNextQueuedRunForAgent checks admission suppression once, then claims
  // runs (sets status "running"), then dispatches each to executeRun, which
  // checks suppression again before it does any work. Suppression (task
  // drain, worktree mode, a database restore) can start in the gap between
  // those two checks. When executeRun's check catches that, the run is
  // already claimed — release it back to "queued" so it does not keep a
  // running execution lock that nothing will ever process. This runs inside
  // the same promise startNextQueuedRunForAgent already tracks in
  // activeRunExecutionPromises, so getTaskDrainStatus() keeps reporting the
  // run as active until the release finishes.
  //
  // The run row, the wakeup request, and the issue execution lock all guard
  // the same claim, so one transaction commits all three writes together. A
  // partial write (for example the run flips to "queued" but the wakeup or
  // issue update then fails) would let the execution promise clear from
  // activeRunExecutionPromises while the wakeup stayed "claimed" or the
  // issue stayed locked to a queued run — task-drain status would then read
  // quiescent while the database still held part of the old claim.
  async function releaseRunClaimedJustBeforeSuppression(runId: string) {
    const now = new Date();
    await db.transaction(async (tx) => {
      const released = await tx
        .update(heartbeatRuns)
        .set({
          status: "queued",
          startedAt: null,
          responsibleUserId: null,
          updatedAt: now,
        })
        .where(
          and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running")),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!released) return;

      if (released.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({ status: "queued", claimedAt: null, updatedAt: now })
          .where(and(eq(agentWakeupRequests.id, released.wakeupRequestId), ne(agentWakeupRequests.status, "cancelled")));
      }

      const context = parseObject(released.contextSnapshot);
      const issueId = readNonEmptyString(context.issueId);
      if (issueId) {
        await tx
          .update(issues)
          .set({
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.id, issueId),
              eq(issues.companyId, released.companyId),
              eq(issues.executionRunId, released.id),
            ),
          );
      }
    });
  }

  async function cancelQueuedRunForBlockedDependencies(
    run: typeof heartbeatRuns.$inferSelect,
    issueId: string,
    unresolvedBlockerIssueIds: string[],
  ) {
    const now = new Date();
    const reason =
      "Cancelled because issue dependencies are still blocked; Paperclip will wake the assignee when blockers resolve";
    const cancelled = await setRunStatus(run.id, "cancelled", {
      finishedAt: now,
      error: reason,
      errorCode: "issue_dependencies_blocked",
      resultJson: {
        ...parseObject(run.resultJson),
        stopReason: "issue_dependencies_blocked",
        effectiveTimeoutSec: 0,
        timeoutConfigured: false,
        timeoutSource: "dependency_gate",
        timeoutFired: false,
      },
    });
    if (!cancelled) return null;

    await setWakeupStatus(run.wakeupRequestId, "skipped", {
      finishedAt: now,
      error: reason,
    });

    await db
      .update(issues)
      .set({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.companyId, run.companyId),
          eq(issues.id, issueId),
          eq(issues.executionRunId, run.id),
        ),
      );

    await appendRunEvent(cancelled, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: reason,
      payload: {
        issueId,
        unresolvedBlockerIssueIds,
      },
    });

    return cancelled;
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
      .where(eq(agents.id, agentId))
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

  async function resumeQueuedRuns() {
    if ((await getSchedulingSuppression()).suppressed) return;
    await resumeExecutionWaitComments();
    const cutoff = await getWorktreeExecutionCutoff();
    const pendingInterrupts = await db.select({ id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId })
      .from(agentWakeupRequests).innerJoin(companies, eq(companies.id, agentWakeupRequests.companyId))
      .where(and(eq(agentWakeupRequests.status, "deferred_issue_execution"),
        eq(companies.status, "active"),
        sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is not null`,
        lte(agentWakeupRequests.updatedAt, new Date(Date.now() - 30_000)),
        cutoff ? gte(agentWakeupRequests.requestedAt, cutoff) : undefined))
      .orderBy(asc(agentWakeupRequests.updatedAt)).limit(50);
    for (const wake of pendingInterrupts) {
      await db.update(agentWakeupRequests).set({ updatedAt: new Date() }).where(and(
        eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ));
      await resumeQueuedCommentInterrupt(wake.companyId, wake.id).catch(err => {
        logger.warn({ err, queueId: wake.id }, "failed to resume interrupted comment queue");
      });
    }
    // A server restart or a message/cleanup race can leave a deferred wake
    // after its owner has released the issue lock. Revisit it through the same
    // release admission, so recovery holds and operator Stops still apply.
    const strandedQueues = await db.select({ wake: agentWakeupRequests })
      .from(agentWakeupRequests)
      .innerJoin(issues, and(eq(issues.companyId, agentWakeupRequests.companyId),
        sql`${issues.id}::text = ${agentWakeupRequests.payload}->>'issueId'`,
        eq(issues.assigneeAgentId, agentWakeupRequests.agentId)))
      .innerJoin(companies, and(eq(companies.id, issues.companyId), eq(companies.status, "active")))
      .where(and(eq(agentWakeupRequests.status, "deferred_issue_execution"),
        isNull(issues.executionRunId),
        or(and(
          sql`jsonb_typeof(${agentWakeupRequests.payload} #> '{_paperclipWakeContext,wakeCommentIds}') = 'array'`,
          sql`${agentWakeupRequests.payload} #> '{_paperclipWakeContext,wakeCommentIds}' <> '[]'::jsonb`,
        ), sql`${agentWakeupRequests.payload}->>'mutation' = 'interaction'`),
        sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is null`,
        cutoff ? gte(agentWakeupRequests.requestedAt, cutoff) : undefined))
      .orderBy(asc(agentWakeupRequests.updatedAt)).limit(50);
    for (const { wake } of strandedQueues) {
      if (!queuedCommentIdsFromWakePayload(wake.payload).length &&
          !await readQueuedInteractionResponse(db, wake.companyId, String(wake.payload?.issueId), wake.payload)) continue;
      const [latest] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, wake.companyId), eq(heartbeatRuns.agentId, wake.agentId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${String(wake.payload?.issueId)}`,
      )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
      await db.update(agentWakeupRequests).set({ updatedAt: new Date() }).where(and(
        eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ));
      if (!latest || latest.runtimeMode !== "legacy" || !isHeartbeatRunTerminalStatus(latest.status)) continue;
      const cancelledAdmission = latest.status === "cancelled" && !latest.startedAt &&
        latest.errorCode === "execution_reconciliation_required";
      if ((latest.status !== "cancelled" || cancelledAdmission) && await getExecutionBlocker(db, wake.companyId, String(wake.payload?.issueId))) {
        await resumeSavedLegacyComments(wake.companyId, wake.id).catch(err => {
          logger.warn({ err, queueId: wake.id }, "failed to deliver saved legacy comment after recovery stopped");
        });
      }
      await releaseIssueExecutionAndPromote(latest, { suppressImmediateRecovery: true }).catch(err => {
        logger.warn({ err, queueId: wake.id }, "failed to promote stranded legacy comments");
      });
    }

    // The cancellation marker is durable intent. Retry while its exact queue
    // is still deferred, including after a failed cleanup promotion or restart.
    // Normal admission still checks process ownership, leases, pauses, and scope.
    const interruptedQueues = await db
      .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId })
      .from(agentWakeupRequests)
      .innerJoin(heartbeatRuns, and(
        sql`${heartbeatRuns.resultJson}->>'queuedCommentInterruptQueueId' = ${agentWakeupRequests.id}::text`,
        eq(heartbeatRuns.companyId, agentWakeupRequests.companyId),
        eq(heartbeatRuns.agentId, agentWakeupRequests.agentId),
      ))
      .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
      .where(and(
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        eq(heartbeatRuns.status, "cancelled"),
        eq(heartbeatRuns.runtimeMode, "legacy"),
        eq(companies.status, "active"),
        cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined,
      ));
    for (const run of interruptedQueues) {
      await releaseIssueExecutionAndPromote(run, { suppressImmediateRecovery: true }).catch((err) => {
        logger.error({ err, runId: run.id }, "failed to retry interrupted comment queue");
      });
    }

    const queuedRuns = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
      .where(
        and(
          eq(heartbeatRuns.status, "queued"),
          eq(companies.status, "active"),
          cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined,
        ),
      );

    const agentIds = [...new Set(queuedRuns.map((r) => r.agentId))];
    for (const agentId of agentIds) {
      await startNextQueuedRunForAgent(agentId);
    }
  }

  async function recoverActiveSessionGoals() {
    if ((await getSchedulingSuppression()).suppressed) {
      return { scanned: 0, enqueued: 0 };
    }
    const sessions = await db
      .select({
        id: agentTaskSessions.id,
        companyId: agentTaskSessions.companyId,
        agentId: agentTaskSessions.agentId,
        issueId: agentTaskSessions.taskKey,
        revision: agentTaskSessions.goalRevision,
      })
      .from(agentTaskSessions)
      .innerJoin(
        issues,
        and(
          sql`${issues.id}::text = ${agentTaskSessions.taskKey}`,
          eq(issues.companyId, agentTaskSessions.companyId),
          eq(issues.assigneeAgentId, agentTaskSessions.agentId),
        ),
      )
      .where(
        and(
          eq(agentTaskSessions.goalDesiredState, "active"),
          eq(agentTaskSessions.goalStatus, "active"),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    let enqueued = 0;
    for (const session of sessions) {
      const run = await enqueueWakeup(session.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "goal_control",
        payload: { issueId: session.issueId, intent: "goal_recovery" },
        idempotencyKey: `goal_recovery:${session.id}:${session.revision}`,
        requestedByActorType: "system",
        contextSnapshot: {
          issueId: session.issueId,
          taskKey: session.issueId,
          resumeSessionGoalHeartbeat: true,
          skipIssueComment: true,
        },
      });
      if (run) enqueued += 1;
    }
    return { scanned: sessions.length, enqueued };
  }

  async function recoverPendingSessionGoalActions() {
    if ((await getSchedulingSuppression()).suppressed) {
      return { scanned: 0, enqueued: 0, alreadyQueued: 0, invalid: 0 };
    }
    const pending = await db
      .select({
        id: agentSessionGoalActions.id,
        requestId: agentSessionGoalActions.requestId,
        payload: agentSessionGoalActions.payloadJson,
        companyId: agentTaskSessions.companyId,
        agentId: agentTaskSessions.agentId,
        adapterType: agentTaskSessions.adapterType,
        issueId: agentTaskSessions.taskKey,
      })
      .from(agentSessionGoalActions)
      .innerJoin(
        agentTaskSessions,
        eq(agentTaskSessions.id, agentSessionGoalActions.sessionId),
      )
      .innerJoin(
        issues,
        and(
          sql`${issues.id}::text = ${agentTaskSessions.taskKey}`,
          eq(issues.companyId, agentTaskSessions.companyId),
          eq(issues.assigneeAgentId, agentTaskSessions.agentId),
        ),
      )
      .where(
        inArray(agentSessionGoalActions.status, [
          "pending",
          "delivering",
          "delivered",
        ]),
      )
      .orderBy(asc(agentSessionGoalActions.createdAt));

    let enqueued = 0;
    let alreadyQueued = 0;
    let invalid = 0;
    for (const action of pending) {
      const control = parseNativeSessionGoalControl(action.payload);
      if (!control || control.requestId !== action.requestId) {
        invalid += 1;
        await failRunnerGoalAction(
          db,
          {
            companyId: action.companyId,
            issueId: action.issueId,
            agentId: action.agentId,
            adapterType: action.adapterType,
          },
          action.requestId,
          "session_goal_control_payload_invalid",
        ).catch(() => undefined);
        continue;
      }

      const inFlight = await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, action.companyId),
            eq(heartbeatRuns.agentId, action.agentId),
            inArray(heartbeatRuns.status, [
              "queued",
              "scheduled_retry",
              "running",
            ]),
          ),
        )
        .then((runs) =>
          runs.some(
            (run) =>
              readNonEmptyString(
                parseObject(run.contextSnapshot).goalControlRequestId,
              ) === action.requestId,
          ),
        );
      if (inFlight) {
        alreadyQueued += 1;
        continue;
      }

      const run = await enqueueWakeup(action.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "goal_control",
        payload: {
          issueId: action.issueId,
          requestId: action.requestId,
          intent: "goal_control_recovery",
        },
        idempotencyKey: `goal_control_recovery:${action.id}`,
        requestedByActorType: "system",
        contextSnapshot: {
          issueId: action.issueId,
          taskKey: action.issueId,
          // Goal controls reconcile the provider session itself and remain
          // valid after issue terminalization (for example, clearing a
          // completed goal from its retained widget).
          resumeIntent: true,
          goalControlRequestId: action.requestId,
          runnerGoalControl: control,
          skipIssueComment: true,
        },
      });
      if (run) enqueued += 1;
    }
    return { scanned: pending.length, enqueued, alreadyQueued, invalid };
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

  // A 403 from claimQueuedRun comes from the run's own persisted identity
  // (an unverifiable interrupt receipt, a manual wake with no user). Those rows
  // do not change, so the claim fails the same way on every pass and restart.
  function isPermanentClaimRejection(err: unknown): err is HttpError {
    return err instanceof HttpError && err.status === 403;
  }

  // Other 4xx rejections can clear later (a responsible user gets assigned, a
  // conflicting claim finishes). Keep the run queued, but do not let it stop
  // the rest of the queue or startup recovery.
  function isDeferrableClaimRejection(err: unknown): err is HttpError {
    return err instanceof HttpError && err.status >= 400 && err.status < 500;
  }

  // Settle runs that can never be claimed. Letting the error escape stalls the
  // agent's queue and, during startup recovery, stops the server from booting.
  async function cancelRejectedQueuedRuns(
    rejected: Array<{ run: typeof heartbeatRuns.$inferSelect; err: HttpError }>,
  ) {
    for (const { run, err } of rejected) {
      logger.warn(
        { err, runId: run.id, agentId: run.agentId, companyId: run.companyId },
        "cancelling queued heartbeat run whose claim was rejected",
      );
      try {
        await cancelRunInternal(
          run.id,
          `Cancelled because the queued run cannot be claimed: ${err.message}`,
          { errorCode: "queued_run_claim_rejected" },
        );
      } catch (cancelErr) {
        logger.error(
          { err: cancelErr, runId: run.id },
          "failed to cancel queued heartbeat run whose claim was rejected; it stays queued for the next recovery pass",
        );
      }
    }
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    if ((await getSchedulingSuppression()).suppressed) return [];
    const cutoff = await getWorktreeExecutionCutoff();
    // Cancelled after the start lock is released: cancelRunInternal promotes the
    // agent's next queued run, which takes this same lock.
    const rejectedClaims: Array<{ run: typeof heartbeatRuns.$inferSelect; err: HttpError }> = [];

    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];
      const invokability = await getAgentInvokability(agent);
      if (!invokability.invokable) {
        if (shouldCancelRunsForNonInvokableAgent(invokability)) {
          await cancelActiveForAgentInternal(
            agentId,
            `Cancelled because the agent is not invokable: ${invokability.reason}`,
          );
        }
        return [];
      }
      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(
        0,
        policy.maxConcurrentRuns - runningCount,
      );
      if (availableSlots <= 0) return [];

      const queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "queued"),
            cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined,
          ),
        )
        .orderBy(asc(heartbeatRuns.createdAt));
      if (queuedRuns.length === 0) return [];

      const dependencyReadiness = await listQueuedRunDependencyReadiness(
        agent.companyId,
        queuedRuns,
      );
      const queuedIssueIds = [
        ...new Set(
          queuedRuns
            .map((run) =>
              readNonEmptyString(parseObject(run.contextSnapshot).issueId),
            )
            .filter((issueId): issueId is string => Boolean(issueId)),
        ),
      ];
      const issueRows = await db
        .select({
          id: issues.id,
          status: issues.status,
          priority: issues.priority,
        })
        .from(issues)
        .where(
          queuedIssueIds.length > 0
            ? and(
                eq(issues.companyId, agent.companyId),
                inArray(issues.id, queuedIssueIds),
              )
            : sql`false`,
        );
      const issueById = new Map(issueRows.map((row) => [row.id, row]));
      const companyAgents = await listCompanyAgentOrgRows(agent.companyId);
      const prioritizedRuns = [...queuedRuns].sort((left, right) => {
        const leftIssueId = readNonEmptyString(
          parseObject(left.contextSnapshot).issueId,
        );
        const rightIssueId = readNonEmptyString(
          parseObject(right.contextSnapshot).issueId,
        );
        const leftReadiness = leftIssueId
          ? dependencyReadiness.get(leftIssueId)
          : null;
        const rightReadiness = rightIssueId
          ? dependencyReadiness.get(rightIssueId)
          : null;
        const leftReady = leftIssueId
          ? (leftReadiness?.isDependencyReady ?? true)
          : true;
        const rightReady = rightIssueId
          ? (rightReadiness?.isDependencyReady ?? true)
          : true;
        const leftIssue = leftIssueId ? issueById.get(leftIssueId) : null;
        const rightIssue = rightIssueId ? issueById.get(rightIssueId) : null;
        const leftRank = leftIssueId
          ? leftReady
            ? leftIssue?.status === "in_progress"
              ? 0
              : 1
            : 3
          : 2;
        const rightRank = rightIssueId
          ? rightReady
            ? rightIssue?.status === "in_progress"
              ? 0
              : 1
            : 3
          : 2;
        if (leftRank !== rightRank) return leftRank - rightRank;
        const leftPriorityRank = issueRunPriorityRank(leftIssue?.priority);
        const rightPriorityRank = issueRunPriorityRank(rightIssue?.priority);
        if (leftPriorityRank !== rightPriorityRank)
          return leftPriorityRank - rightPriorityRank;
        return left.createdAt.getTime() - right.createdAt.getTime();
      });

      const claimedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
      for (const queuedRun of prioritizedRuns) {
        if (claimedRuns.length >= availableSlots) break;
        let claimed: typeof heartbeatRuns.$inferSelect | null;
        try {
          claimed = await claimQueuedRun(queuedRun, companyAgents);
        } catch (err) {
          if (isPermanentClaimRejection(err)) {
            rejectedClaims.push({ run: queuedRun, err });
            continue;
          }
          if (!isDeferrableClaimRejection(err)) throw err;
          logger.warn(
            { err, runId: queuedRun.id, agentId: queuedRun.agentId, companyId: queuedRun.companyId },
            "queued heartbeat run claim was rejected; leaving it queued for the next recovery pass",
          );
          continue;
        }
        if (claimed) claimedRuns.push(claimed);
      }
      if (claimedRuns.length === 0) return [];

      for (const claimedRun of claimedRuns) {
        const execution = executeRun(claimedRun.id).catch((err) => {
          logger.error(
            { err, runId: claimedRun.id },
            "queued heartbeat execution failed",
          );
        });
        // Register the in-flight execution so drainActiveRunExecutions() can await
        // it. executeRun resolves only after its finally block finishes flushing
        // run rows/events, so awaiting this promise guarantees the run's writes
        // have landed before a caller (e.g. a test's afterEach) mutates the DB.
        activeRunExecutionPromises.add(execution);
        void execution.finally(() => {
          // drainActiveRunExecutions loops on activeRunExecutionPromises.size,
          // so an entry that never clears here would hang it forever.
          activeRunExecutionPromises.delete(execution);
        });
      }
      return claimedRuns;
    }).finally(() => cancelRejectedQueuedRuns(rejectedClaims));
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

  // Public wakeup entry point. Callers dispatch it fire-and-forget, so register
  // the promise in activeWakeupPromises before it starts its asynchronous
  // prologue. drainActiveRunExecutions can then await a wake that is still before
  // run registration. Internal callers reference enqueueWakeup directly and
  // already await it, so they do not need this registration.
  function trackWakeup(
    agentId: string,
    opts: WakeupOptions = {},
  ): ReturnType<typeof enqueueWakeup> {
    const promise = enqueueWakeup(agentId, opts);
    activeWakeupPromises.add(promise);
    void promise
      .catch(() => {})
      .finally(() => {
        activeWakeupPromises.delete(promise);
      });
    return promise;
  }

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
      if (isDotRun && (executionForcedToKubernetes || managedSandboxOnly || selectedEnvironmentId && selectedEnvironmentId !== localEnvironment.id)) {
        throw new ConfigurationIncompleteFailure("Dot currently requires a self-hosted local Runner controller; this environment policy is not supported.", { provider: "openai_dot", reason: "controller_environment_unsupported" });
      }
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
        let saved = await instructionCopies.collectStopped({ companyId: agent.companyId, runId: run.id, target: executionTarget });
        // Capture before disposal. Exhausted bounded collection leaves a durable
        // explicit loss report, never a claim that missing bytes were saved.
        while (saved?.state === "pending_collection" && saved.attempts < 3) {
          saved = await instructionCopies.collectStopped({ companyId: agent.companyId, runId: run.id, target: executionTarget });
        }
        if (!saved) return;
        if (saved.state !== "superseded") await recordInstructionSave(saved);
      };
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
            const priorFileRun = taskSessionForRun?.lastRunId
              ? await db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(and(
                  eq(heartbeatRuns.id, taskSessionForRun.lastRunId), eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id))).then(rows => rows[0])
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
              instructionCopy = await prepareInstructions(nativeInstructionReservation?.reuseRunId);
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
        let nativeExecution: NativeExecutionInput | null = null;
        let getNativeFreshSessionHandoff: (() => Promise<string | null>) | undefined;
        let nativeRunnerInstanceId: string | null = null;
        if (nativeRuntimeResolution.kind === "native") {
          if (!issueRef) {
            throw new Error("native_runtime_ineligible: issue is required");
          }
          const nativeExecutionWorkspaceId =
            persistedExecutionWorkspace?.id ?? run.id;
          const nativeReviewContext = readNativeReviewAssignmentContext(context);
          const nativeReview = nativeReviewContext ? await getNativeReviewAssignment(db, {
            companyId: agent.companyId, issueId: issueRef.id, agentId: agent.id,
            contextSnapshot: nativeReviewContext,
          }) : null;
          if (nativeReviewContext && !nativeReview) throw new Error("native_review_assignment_no_longer_available");
          const nativeReviewRequest = nativeReview
            ? buildNativeReviewRequest({
                title: nativeReview.interaction.title,
                summary: nativeReview.interaction.summary,
                payload: nativeReview.interaction.payload,
              })
            : null;
          const persistedContract = run.completionContractId
            ? await db
                .select()
                .from(completionContracts)
                .where(
                  and(
                    eq(completionContracts.id, run.completionContractId),
                    eq(completionContracts.companyId, agent.companyId),
                    eq(completionContracts.issueId, issueRef.id),
                  ),
                )
                .limit(1)
                .then((rows) => rows[0] ?? null)
            : null;
          // Only a server-verified human resolution may supply a current answer
          // reference. Tool/agent results and generated summaries stay evidence.
          const currentHumanResponseId = !nativeReviewRequest
            ? executionContinuation?.humanResponses?.find(
                (response) => response.id === executionContinuation.trigger.interactionId,
              )?.id
            : undefined;
          const immediateCompletion = (() => {
            if (nativeReviewRequest) return { requests: [nativeReviewRequest], sources: [null] };
            const { requests, sources } = nativeCompletionRequestsWithSources(
              safeWakeComments.length > 0
                ? safeWakeComments
                : safeWakeCommentContext?.body
                  ? [safeWakeCommentContext]
                  : [],
              {
                requiredFullWakeCommentCount:
                  paperclipWakePayload?.fallbackFetchNeeded === true &&
                  CHAT_PROVIDERS.some(
                    (provider) =>
                      provider ===
                      paperclipWakePayload.externalChatProvider,
                  ) &&
                  Array.isArray(paperclipWakePayload.commentIds)
                    ? paperclipWakePayload.commentIds.length
                    : undefined,
              },
            );
            // Preserve every admitted pending chat request while also
            // retaining newer user direction materialized by recovery.
            // A file-only wake must not inherit an old task objective.
            const latestComment =
              executionContinuation?.messages.findLast(
                (message) =>
                  message.authorType === "user" &&
                  !message.createdByRunId &&
                  !message.deleted &&
                  message.body.trim().length > 0,
              );
            const latestRequest = latestComment?.body;
            if (
              latestRequest &&
              !requests.some(
                (request) => request === latestRequest.trim(),
              )
            ) {
              requests.push(latestRequest.trim());
              sources.push(nativeCompletionSource("comment", latestComment!.id, latestRequest));
            }
            return { requests: requests.length > 0 ? requests : undefined, sources };
          })();
          // Rebuilding a default contract is not a change in user direction.
          // In particular, an upgraded checkpoint may have an intentionally
          // authored contract and no continuation envelope yet.
          const completionContract =
            persistedContract && persistedNativeExecutionInput
              ? {
                  row: persistedContract,
                  contract: persistedContract.contractJson as never,
                }
              : await ensureNativeCompletionContract({
                  db,
                  companyId: agent.companyId,
                  issue: issueRef,
                  actorId: agent.id,
                  immediateRequest:
                    nativeReviewRequest ?? (currentHumanResponseId
                      ? null
                      : executionContinuation?.objective ?? safeWakeCommentContext?.body ?? null),
                  // The ordinary initial objective is selected by the server-owned
                  // continuation envelope. Carry its explicit description source
                  // through the singular-request compatibility path; do not infer
                  // provenance for review requests, answers, or wake fallbacks.
                  immediateRequestSource: nativeImmediateObjectiveSource({
                    issueId: issueRef.id,
                    objectiveSource: executionContinuation?.objectiveSource,
                    excluded: Boolean(nativeReviewRequest || currentHumanResponseId),
                  }),
                  humanResponseId: currentHumanResponseId,
                  immediateRequests: immediateCompletion.requests,
                  immediateRequestSources: immediateCompletion.sources,
                });
          const taskNativeSessionId = !taskSessionCredentialCompatible ? null : readNonEmptyString(
            taskSessionDecodedParams?.sessionId,
          );
          // Compatibility for native retry rows created before same-run restart
          // recovery existed. Only an entirely unused replacement row may
          // inherit its source checkpoint; any process/provider evidence on the
          // replacement makes the ownership ambiguous and therefore ineligible.
          const legacyRetrySource =
            run.retryOfRunId && !isFailedChatRunRetry
              ? await db
                  .select({
                    id: heartbeatRuns.id,
                    companyId: heartbeatRuns.companyId,
                    agentId: heartbeatRuns.agentId,
                    runnerInstanceId: heartbeatRuns.runnerInstanceId,
                    nativeSessionId: heartbeatRuns.nativeSessionId,
                    runnerProfileJson: heartbeatRuns.runnerProfileJson,
                    runtimeMode: heartbeatRuns.runtimeMode,
                    status: heartbeatRuns.status,
                  })
                  .from(heartbeatRuns)
                  .where(
                    and(
                      eq(heartbeatRuns.id, run.retryOfRunId),
                      eq(heartbeatRuns.companyId, agent.companyId),
                      eq(heartbeatRuns.agentId, agent.id),
                    ),
                  )
                  .limit(1)
                  .then((rows) => rows[0] ?? null)
              : null;
          const nativeBootstrapHasProviderEvidence =
            legacyRetrySource ||
            run.nativeSessionId ||
            persistedNativeExecutionInput
              ? await db
                  .select({ id: heartbeatRunEvents.id })
                  .from(heartbeatRunEvents)
                  .where(
                    and(
                      eq(heartbeatRunEvents.runId, run.id),
                      inArray(heartbeatRunEvents.eventType, [
                        "harness.ready",
                        "session.started",
                        "session.resumed",
                        "session.updated",
                        "turn.started",
                        "provider.event",
                        "provider.rpc_result",
                      ]),
                    ),
                  )
                  .limit(1)
                  .then((rows) => rows.length > 0)
              : false;
          const compatibleLegacyRetrySource =
            !managedAiRuntime && !isConversation(issueContext) && context.forceFreshSession !== true && isUnusedLegacyNativeRetryReplacement({
              replacement: run,
              source: legacyRetrySource,
              hasProviderEvents: nativeBootstrapHasProviderEvidence,
            })
              ? legacyRetrySource
              : null;
          const legacyRetrySessionId =
            compatibleLegacyRetrySource?.nativeSessionId;
          const taskResumeRunId =
            taskSessionForRun?.lastRunId &&
            taskSessionForRun.lastRunId !== run.id &&
            isNativeSessionId(taskNativeSessionId)
              ? taskSessionForRun.lastRunId
              : null;
          const resumableTaskSessionId = isDotRun ? null : taskResumeRunId
            ? taskNativeSessionId
            : (legacyRetrySessionId ?? null);
          const requestedNativeSessionId =
            run.nativeSessionId ?? resumableTaskSessionId;
          // A task-session lastRunId can lag a failed turn or point at an older
          // normalized session. Find the newest exact-session authority instead.
          // Rows that already acquired provider authority are progress barriers,
          // even when they do not contain a usable checkpoint.
          const previousNativeRun =
            requestedNativeSessionId &&
            isUnusedNativeSessionBootstrap(
              run,
              nativeBootstrapHasProviderEvidence,
            )
              ? await findNativeSessionResumeRun(db, {
                  companyId: agent.companyId,
                  agentId: agent.id,
                  issueId: issueRef.id,
                  normalizedSessionId: requestedNativeSessionId,
                  currentRunId: run.id,
                  beforeCreatedAt: run.createdAt,
                })
              : null;
          nativeRunnerInstanceId =
            previousNativeRun?.runnerInstanceId &&
            previousNativeRun.nativeSessionId ===
              (run.nativeSessionId ?? resumableTaskSessionId)
              ? previousNativeRun.runnerInstanceId
              : (run.runnerInstanceId ?? randomUUID());
          let nativeSessionId =
            run.nativeSessionId ?? resumableTaskSessionId ?? randomUUID();
          let nativeResumeCheckpoint: ReturnType<
            typeof rebindNativeSessionCheckpoint
          > = null;
          const agentLifecyclePolicy =
            parseObject(agent.adapterConfig).lifecycleMode === "warm"
              ? {
                  mode: "warm" as const,
                  idleTimeoutMs: resolvePaperclipRunnerIdleTimeoutMs(
                    parseObject(agent.adapterConfig).idleTimeoutMs,
                  ),
                }
              : { mode: "per_turn" as const, idleTimeoutMs: null };
          const environmentLifecyclePolicy =
            executionTarget?.kind === "remote" &&
            executionTarget.transport === "sandbox"
              ? (executionTarget.runnerLifecyclePolicy ?? null)
              : null;
          // Native Codex owns a durable, session-scoped home. It flushes refreshed
          // auth into each invocation's private home before that home is removed.
          // Other managed harnesses still require per-turn credential cleanup.
          const supportsManagedWarmSession = agent.adapterType === "paperclip_runner" &&
            nativeRuntimeResolution.profile.backend === "codex_app_server";
          const effectiveLifecyclePolicy = persistedNativeExecutionInput?.session.lifecyclePolicy ??
            (nativeRuntimeResolution.profile.backend === "openai_dot_mcp" || managedAiRuntime && !supportsManagedWarmSession
              ? { mode: "per_turn" as const, idleTimeoutMs: null }
              : environmentLifecyclePolicy ?? agentLifecyclePolicy);
          if (
            effectiveLifecyclePolicy.mode === "warm" &&
            executionTarget?.kind === "remote" &&
            executionTarget.transport === "sandbox" &&
            (executionTarget.reusableLeaseConfigured !== true ||
              executionTarget.effectiveCapabilities?.reusableLeases !== true)
          ) {
            throw new Error("runner_warm_environment_requires_reusable_lease");
          }
          const persistedProfile = persistedRunnerProfile;
          if (persistedNativeExecutionInput) {
            nativeExecution = persistedNativeExecutionInput;
            if (
              nativeExecution.binding.companyId !== agent.companyId ||
              nativeExecution.binding.runId !== run.id ||
              nativeExecution.binding.issueId !== issueRef.id ||
              nativeExecution.binding.agentId !== agent.id ||
              nativeExecution.binding.executionWorkspaceId !==
                nativeExecutionWorkspaceId ||
              nativeExecution.completionContract.id !==
                completionContract.row.id ||
              nativeExecution.completionContract.sha256 !==
                completionContract.row.canonicalSha256
            )
              throw new Error(
                "native_execution_input_persisted_binding_mismatch",
              );
            // Recover only the originally admitted request. A stored idle
            // checkpoint can precede an already-started provider turn, so even
            // apparent idleness is not authority to rewrite its contract.
            // Newer user direction retains its separate durable wakeup cause.
            // A failed pre-bootstrap attempt may have persisted its immutable
            // input before discovering that lastRunId no longer names this
            // session. Restore only an exactly compatible prior checkpoint;
            // never rewrite the admitted input or skip current provider work.
            if (
              previousNativeRun &&
              isUnusedNativeSessionBootstrap(
                run,
                nativeBootstrapHasProviderEvidence,
              )
            ) {
              nativeResumeCheckpoint = rebindNativeSessionCheckpoint({
                previousRun: previousNativeRun,
                currentExecution: nativeExecution,
                executionTargetKind: executionTarget?.kind ?? "local",
              });
            }
            if (nativeExecution.provider.kind === "claude_managed") {
              const recoveryProfile = await managedAgentProfileService(
                db,
              ).requireQualified(
                agent.companyId,
                nativeExecution.provider.managedProfile.profileId,
              );
              assertManagedProfileRecoveryBinding({
                adapterConfig: agent.adapterConfig,
                snapshot: nativeExecution.provider.managedProfile,
                stored: recoveryProfile,
              });
            }
            if (nativeExecution.provider.kind === "aws_agentcore") {
              const recoveryProfile = await remoteAgentProfileService(
                db,
              ).requireQualified(
                agent.companyId,
                nativeExecution.provider.agentCoreProfile.profileId,
                "aws_bedrock_agentcore_harness",
              );
              assertAgentCoreProfileRecoveryBinding({
                snapshot: nativeExecution.provider.agentCoreProfile,
                stored: recoveryProfile,
              });
            }
          } else {
            const interactionId = readNonEmptyString(context.interactionId);
            const interactionResponses = context[
              EXTERNAL_CHAT_QUESTION_RESPONSE_KEY
            ]
              ? await materializeExternalChatQuestionResponseInput({
                  db,
                  binding: {
                    companyId: agent.companyId,
                    issueId: issueRef.id,
                    runId: run.id,
                    agentId: agent.id,
                  },
                  contextSnapshot: context,
                })
              : await materializeNativeInteractionResponses({
                  db,
                  companyId: agent.companyId,
                  issueId: issueRef.id,
                  runId: run.id,
                  agentId: agent.id,
                  interactionIds: Array.isArray(context.interactionIds)
                    ? [
                        ...new Set([
                          ...(interactionId ? [interactionId] : []),
                          ...context.interactionIds.filter(
                            (id): id is string => typeof id === "string",
                          ),
                        ]),
                      ]
                    : interactionId
                      ? [interactionId]
                      : [],
                });
            const runnerAdapterConfig = parseObject(agent.adapterConfig);
            const managedProfile =
              nativeRuntimeResolution.profile.backend ===
              "claude_managed_agents_api"
                ? await managedAgentProfileService(db).requireQualified(
                    agent.companyId,
                    readNonEmptyString(runnerAdapterConfig.managedProfileId) ??
                      "",
                  )
                : null;
            const agentCoreProfile =
              nativeRuntimeResolution.profile.backend ===
              "aws_agentcore_harness_api"
                ? await remoteAgentProfileService(db).requireQualified(
                    agent.companyId,
                    readNonEmptyString(
                      runnerAdapterConfig.agentCoreProfileId,
                    ) ?? "",
                    "aws_bedrock_agentcore_harness",
                  )
                : null;
            if (managedProfile) {
              const rawApiKeyBinding = parseObject(
                runnerAdapterConfig.env,
              ).ANTHROPIC_API_KEY;
              const boundSecretId =
                typeof rawApiKeyBinding === "object" &&
                rawApiKeyBinding !== null
                  ? readNonEmptyString(
                      (rawApiKeyBinding as Record<string, unknown>).secretId,
                    )
                  : null;
              if (boundSecretId !== managedProfile.apiKeySecretId) {
                throw new ConfigurationIncompleteFailure(
                  "configuration incomplete: Claude Managed profile API key is not bound at env.ANTHROPIC_API_KEY",
                  {
                    configurationIncomplete: {
                      reason: "managed_agent_profile_secret_binding_mismatch",
                      companyId: agent.companyId,
                      agentId: agent.id,
                      profileId: managedProfile.id,
                      requiredEnvKeys: ["ANTHROPIC_API_KEY"],
                    },
                  },
                );
              }
            }
            const executionMode =
              issueRef.workMode === "planning" && !isConversation(issueContext) && !acceptedPlanContinuationWake
                ? ("plan" as const)
                : ("default" as const);
            const pinnedPlan =
              executionMode === "plan"
                ? await documentService(db).getIssueDocumentByKey(
                    issueRef.id,
                    "plan",
                  )
                : null;
            const pinnedReviewContext =
              executionMode === "plan"
                ? await buildPlanReviewContext({
                    db,
                    companyId: agent.companyId,
                    issueId: issueRef.id,
                    issueWorkMode: issueRef.workMode,
                    interactionId: readNonEmptyString(context.interactionId),
                  })
                : null;
            const pinnedPlanMarkdown = pinnedPlan?.body ?? "";
            const dotBinding = nativeRuntimeResolution.profile.backend === "openai_dot_mcp"
              ? await dotRunnerBroker(db).snapshot(agent.companyId, agent.id, String(parseObject(agent.adapterConfig).dotBindingId ?? "")) : undefined;
            const nativeRuntimeContext = await buildNativeRuntimeContext({
              db,
              agent,
              runId: run.id,
              runtimeConfig,
              runtimeSkillEntries,
              instructionWorkingCopy: instructionCopy ? { rootPath: instructionCopy.executionRoot, entryPath: instructionCopy.entryFile, ...(isAgentDirectoryCopy(instructionCopy) ? { kind: "agent_files" as const } : {}) } : undefined,
            });
            getNativeFreshSessionHandoff = nativeReviewRequest ? undefined : getFreshSessionHandoff;
            const nativeProviderConfig = nativeRuntimeResolution.profile.backend === "codex_app_server"
              || nativeRuntimeResolution.profile.backend === "opencode_server"
              ? projectPaperclipRunnerTaskConfig(
                  nativeRuntimeResolution.profile.backend,
                  agent.adapterConfig,
                  issueAssigneeOverrides?.adapterConfig,
                  managedAiRuntime ? readNonEmptyString(resolvedConfig.model) ?? undefined : undefined,
                )
              : agent.adapterConfig;
            const requestedNativeProvider = resolvePaperclipRunnerNativeProviderInput({
              backend: nativeRuntimeResolution.profile.backend,
              adapterConfig: nativeProviderConfig, managedProfile, agentCoreProfile, dotBinding,
            });
            const codexCliVersion = agent.adapterType === "paperclip_runner" && requestedNativeProvider.provider === "codex"
              ? await readRemoteCodexModelCliVersion({
                  model: requestedNativeProvider.model,
                  target: executionTarget,
                  remoteCodexPath: runtimeEnv.PAPERCLIP_RUNNER_REMOTE_CODEX_PATH,
                  remoteCodexNpmSpec: runtimeEnv.PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC,
                }) : null;
            const nativeProvider = codexCliVersion
              ? resolvePaperclipRunnerNativeProviderInput({
                  backend: nativeRuntimeResolution.profile.backend,
                  adapterConfig: nativeProviderConfig, codexCliVersion, managedProfile, agentCoreProfile, dotBinding,
                }) : requestedNativeProvider;
            if (nativeProvider.model !== requestedNativeProvider.model) {
              await postNativeModelFallbackWarning({
                issuesSvc, onEvent: onAdapterEvent, issueId: issueRef.id, runId: run.id,
                requestedModel: requestedNativeProvider.model, effectiveModel: nativeProvider.model,
                codexCliVersion: codexCliVersion!,
              });
            }
            const buildExecution = ({ normalizedSessionId, resumedSession }: { normalizedSessionId: string; resumedSession: boolean }) =>
                  buildNativeExecutionInput({
                    agentKeyId: agentIdentity?.keyId,
                    companyId: agent.companyId,
                    runId: run.id,
                    issue: nativeReviewRequest ? { ...issueRef, title: `Review: ${issueRef.title}`, description: nativeReviewRequest } : issueRef,
                    taskPrompt: [
                      nativeReviewRequest ?? readNonEmptyString(
                        selectPaperclipTaskMarkdown(context, {
                          resumedSession: false,
                          includeCommunicationGuidance: false,
                        }),
                      ) ??
                      `# ${issueRef.identifier ?? issueRef.id}: ${issueRef.title}`,
                      nativeRuntimeResolution.profile.backend !== "openai_dot_mcp" && projectRepositoryPaths.length > 0
                        ? `## Project repositories\nThe task workspace also contains these editable Git repositories:\n${projectRepositoryPaths.map((repo) => `- ${repo}`).join("\n")}`
                        : null,
                    ].filter(Boolean).join("\n\n"),
                    initialCommunicationGuidance: nativeReviewRequest ? null : readNonEmptyString(context.paperclipTaskCommunicationGuidance),
                    wakePayload: context.paperclipWake,
                    turnContext: context.paperclipTurnContext,
                    resumedSession,
                    previousTurn: (() => {
                      if (!previousNativeRun || nativeReviewRequest) return null;
                      try {
                        const previousTask = parseNativeExecutionInput(parseObject(previousNativeRun.runnerProfileJson).nativeExecutionInput).task;
                        if (paperclipWakePayload?.externalChatProvider) {
                          // External native inputs use a neutral task title. Compare
                          // the saved canonical brief so old provider text is not
                          // repeated as a change, while genuine edits still arrive.
                          const savedIssue = parseObject(parseObject(previousNativeRun.contextSnapshot).paperclipIssue);
                          if (savedIssue.id !== issueRef.id || typeof savedIssue.title !== "string" ||
                            (savedIssue.description !== null && typeof savedIssue.description !== "string")) return null;
                          return { runId: previousNativeRun.id, task: { title: savedIssue.title, description: savedIssue.description } };
                        }
                        return { runId: previousNativeRun.id, task: previousTask };
                      } catch {
                        // An invalid prior snapshot must use the fresh bootstrap.
                        return null;
                      }
                    })(),
                    conversationMode: context.conversationMode === true,
                    agentId: agent.id,
                    workspace: {
                      // Projectless paperclip_runner tasks still have a resolved local cwd. Bind that
                      // transient workspace to the run id so the native input remains durable and replayable
                      // without fabricating a project-scoped execution_workspaces row.
                      id: nativeExecutionWorkspaceId,
                      cwd: executionWorkspace.cwd,
                      repoUrl: executionWorkspace.repoUrl,
                      repoRef: executionWorkspace.repoRef,
                      branchName: executionWorkspace.branchName,
                    },
                    normalizedSessionId,
                    executionMode,
                    planningContext:
                      executionMode === "plan"
                        ? {
                            documentId: pinnedPlan?.id ?? null,
                            baseRevisionId:
                              pinnedPlan?.latestRevisionId ?? null,
                            baseRevisionNumber:
                              pinnedPlan?.latestRevisionNumber ?? 0,
                            markdown: pinnedPlanMarkdown,
                            sha256: createHash("sha256")
                              .update(pinnedPlanMarkdown)
                              .digest("hex"),
                            reviewContext: pinnedReviewContext
                              ? (structuredClone(
                                  pinnedReviewContext,
                                ) as unknown as Record<string, unknown>)
                              : {},
                          }
                        : null,
                    ...nativeProvider,
                    lifecyclePolicy: effectiveLifecyclePolicy,
                    interactionResponses,
                    completionContract: {
                      id: completionContract.row.id,
                      sha256: completionContract.row.canonicalSha256,
                      schemaVersion: completionContract.row.schemaVersion,
                      contract: completionContract.contract,
                      sources: "sources" in completionContract ? completionContract.sources : undefined,
                    },
                    runtimeContext: nativeRuntimeContext,
                  });
            const backendDescriptor = await describeRunnerdNativeSessionBackend(buildExecution({
              normalizedSessionId: nativeSessionId, resumedSession: previousNativeRun !== null,
            }));
            const nativeExecutionWithCheckpoint = buildNativeExecutionWithCheckpoint({
              previousRun: previousNativeRun,
              normalizedSessionId: nativeSessionId,
              executionTargetKind: executionTarget?.kind ?? "local",
              toolRefreshOnResume: backendDescriptor.capabilities.toolRefreshOnResume === true,
              refreshTools: context.refreshTools === true,
              buildExecution,
            });
            nativeExecution = nativeExecutionWithCheckpoint.execution;
            nativeResumeCheckpoint = nativeExecutionWithCheckpoint.checkpoint;
            if (
              nativeSessionId !==
              nativeExecutionWithCheckpoint.normalizedSessionId
            ) {
              nativeRunnerInstanceId = randomUUID();
            }
            nativeSessionId = nativeExecutionWithCheckpoint.normalizedSessionId;
          }
          const nativeSandboxLifecycle = resolveNativeSandboxLifecycle({
            adapterType: agent.adapterType,
            lifecyclePolicy: nativeExecution.session.lifecyclePolicy,
            target: executionTarget,
          });
          if (nativeSandboxLifecycle) {
            nativeLifecycleTelemetryForRun = {
              provider: nativeExecution.provider.kind,
              harness: nativeExecution.session.driverKind,
              lifecycleMode: nativeExecution.session.lifecyclePolicy.mode,
              sandboxResource: nativeSandboxLifecycle.sandboxResource,
            };
            const selectedLifecycleSpan = getStartupTracer(
              "paperclip.environment-lifecycle",
            ).startSpan("sandbox.lifecycle.selected", {
              attributes: {
                "paperclip.native.span.provider": nativeExecution.provider.kind,
                "paperclip.native.span.harness":
                  nativeExecution.session.driverKind,
                "paperclip.native.span.lifecycle_mode":
                  nativeExecution.session.lifecyclePolicy.mode,
                "paperclip.native.span.sandbox_resource":
                  nativeSandboxLifecycle.sandboxResource,
                "paperclip.native.span.outcome": "selected",
                "paperclip.native.span.bytes_transferred": 0,
              },
            });
            selectedLifecycleSpan.end();
          }
          providerResourceDispositionForRun =
            nativeSandboxLifecycle?.sandboxResource === "keep_running"
              ? "keep_running"
              : nativeSandboxLifecycle?.sandboxResource === "stop_and_reuse"
                ? "stop_and_retain"
                : nativeSandboxLifecycle?.sandboxResource ===
                    "destroy_after_turn"
                  ? "destroy"
                  : undefined;
          await options.beforeNativeRuntimeSelection?.(run.id);
          const nativeSelected = await db.transaction(async (tx) => {
            const lockedRun = await tx
              .select()
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, run.id))
              .for("update")
              .limit(1)
              .then((rows) => rows[0] ?? null);
            if (!lockedRun) throw new Error("native_runtime_run_missing");
            // Cancellation and runtime selection serialize on this row. A
            // stopped preparation must never create a new native coordinator.
            if (lockedRun.status !== "running" || lockedRun.resultJson?.startupCancellation) return false;
            if (lockedRun.runtimeMode === "legacy" && lockedRun.controllerBootId &&
                !(await renewLegacyControllerLease(tx as unknown as Db, lockedRun))) {
              nativeOwnershipHeld = true;
              return false;
            }
            if (
              lockedRun.runtimeModeResolvedAt &&
              lockedRun.runtimeMode !== "native"
            ) {
              throw new Error("native_runtime_mode_conflict");
            }
            const lockedProfile = parseObject(lockedRun.runnerProfileJson);
            const persistedNativeSessionId =
              await prepareNativeSessionBootstrapPersistence(tx, {
                run: lockedRun,
                selectedSessionId: nativeSessionId,
                execution: nativeExecution!,
                restoringCheckpoint: nativeResumeCheckpoint !== null,
              });
            await tx
              .update(heartbeatRuns)
              .set({
                runtimeMode: "native",
                runtimeModeResolverVersion:
                  lockedRun.runtimeModeResolverVersion ??
                  nativeRuntimeResolution.resolverVersion,
                runtimeModeReason:
                  lockedRun.runtimeModeReason ?? nativeRuntimeResolution.reason,
                runtimeModeResolvedAt:
                  lockedRun.runtimeModeResolvedAt ?? new Date(),
                runnerProfileJson: {
                  ...nativeRuntimeResolution.profile,
                  ...lockedProfile,
                  ...(lockedProfile.nativeExecutionInput
                    ? {}
                    : { recoveryEventInventoryVersion: 1 }),
                  ...(providerTraceRequested
                    ? {
                        providerTrace: {
                          mode: "raw",
                          traceId: providerTraceCapture?.metadata.id ?? null,
                          maxBytes: PROVIDER_TRACE_MAX_BYTES,
                        },
                      }
                    : {}),
                  nativeExecutionInput:
                    lockedProfile.nativeExecutionInput ?? nativeExecution,
                  nativeToolContractFingerprint:
                    nativeToolContractFingerprintForTarget(
                      executionTarget?.kind ?? "local",
                    ),
                  ...(lockedProfile.sessionCheckpoint != null
                    ? { sessionCheckpoint: lockedProfile.sessionCheckpoint }
                    : nativeResumeCheckpoint
                      ? {
                          sessionCheckpoint:
                            nativeResumeCheckpoint as unknown as Record<
                              string,
                              unknown
                            >,
                        }
                      : {}),
                },
                runnerInstanceId:
                  previousNativeRun?.runnerInstanceId &&
                  persistedNativeSessionId === previousNativeRun.nativeSessionId
                    ? previousNativeRun.runnerInstanceId
                    : lockedRun.nativeSessionId !== persistedNativeSessionId
                      ? nativeRunnerInstanceId
                      : (lockedRun.runnerInstanceId ?? nativeRunnerInstanceId),
                nativeSessionId: persistedNativeSessionId,
                processPid:
                  lockedRun.processPid ??
                  (previousNativeRun?.nativeSessionId === nativeSessionId
                    ? previousNativeRun.processPid
                    : null),
                processGroupId:
                  lockedRun.processGroupId ??
                  (previousNativeRun?.nativeSessionId === nativeSessionId
                    ? previousNativeRun.processGroupId
                    : null),
                processStartedAt:
                  lockedRun.processStartedAt ??
                  (previousNativeRun?.nativeSessionId === nativeSessionId
                    ? previousNativeRun.processStartedAt
                    : null),
                nativeIssueId: lockedRun.nativeIssueId ?? issueRef.id,
                driverKind:
                  lockedRun.driverKind ??
                  nativeExecution?.session.driverKind ??
                  "codex_app_server",
                driverVersion: lockedRun.driverVersion ?? "phase6-v1",
                completionContractId:
                  lockedRun.completionContractId ?? completionContract.row.id,
                completionContractSha256:
                  lockedRun.completionContractSha256 ??
                  completionContract.row.canonicalSha256,
                nativePhase: lockedRun.nativePhase ?? "observed",
                nativePhaseUpdatedAt:
                  lockedRun.nativePhaseUpdatedAt ?? new Date(),
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, run.id));
            await tx
              .insert(nativeRunFinalizations)
              .values({
                runId: run.id,
                companyId: agent.companyId,
                issueId: issueRef.id,
                phase: "observed",
              })
              .onConflictDoNothing();
            return true;
          });
          if (!nativeSelected) return;
          controllerLease.stop();
          nativeWorkspaceSync = await prepareNativeWorkspaceSync({
            db,
            runId: run.id,
            companyId: agent.companyId,
            workspaceId: nativeExecutionWorkspaceId,
            workspaceLocalDir: executionWorkspace.cwd,
            target: executionTarget,
            lease: activeEnvironmentLease.lease,
            restartRecovery: runOptions.nativeRestartRecovery,
            sameRunRecovery: Boolean(runOptions.nativeLeaseOwner),
            resourceDisposition: providerResourceDispositionForRun,
          });
        } else {
          const legacyWarmLifecycle =
            executionTarget?.kind === "remote" &&
            executionTarget.transport === "sandbox" &&
            executionTarget.runnerLifecyclePolicy?.mode === "warm"
              ? resolveReusableSandboxLifecycle({
                  lifecyclePolicy: executionTarget.runnerLifecyclePolicy,
                  target: executionTarget,
                })
              : null;
          if (legacyWarmLifecycle?.sandboxResource === "keep_running") {
            providerResourceDispositionForRun = "keep_running";
          }
          await db
            .update(heartbeatRuns)
            .set({
              runtimeMode: "legacy",
              runtimeModeResolverVersion:
                nativeRuntimeResolution.resolverVersion,
              runtimeModeReason: nativeRuntimeResolution.reason,
              runtimeModeResolvedAt: run.runtimeModeResolvedAt ?? new Date(),
              // Preserve server-owned admission and dispatch evidence on this
              // row; never copy another run's execution profile.
              runnerProfileJson: sql`(case when ${heartbeatRuns.runnerProfileJson} ? ${CHAT_CONTROL_RECOVERY_ADMISSION_KEY}
                then jsonb_build_object(${CHAT_CONTROL_RECOVERY_ADMISSION_KEY}::text, ${heartbeatRuns.runnerProfileJson}->${CHAT_CONTROL_RECOVERY_ADMISSION_KEY})
                else '{}'::jsonb end)
              || (case when ${heartbeatRuns.runnerProfileJson} ? 'adapterDispatch'
                then jsonb_build_object('adapterDispatch', ${heartbeatRuns.runnerProfileJson}->'adapterDispatch')
                else '{}'::jsonb end) || ${JSON.stringify(providerTraceRequested ? { providerTrace: { mode: "raw", traceId: providerTraceCapture?.metadata.id ?? null, maxBytes: PROVIDER_TRACE_MAX_BYTES } } : {})}::jsonb`,
              updatedAt: new Date(),
            })
            .where(eq(heartbeatRuns.id, run.id));
        }
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
                    instructionWorkingCopy: instructionCopy ? {
                      runId: run.id,
                      root: instructionCopy.executionRoot,
                      ...(instructionCopy.receipt?.warm === true ? { checkpointWarm: async () => {
                        const saved = await instructionCopies.checkpointWarm({ companyId: agent.companyId, runId: run.id, target: executionTarget });
                        if (saved) await recordInstructionSave(saved);
                        return saved?.state === "warm_saved" && saved.errorCode === null;
                      } } : {}),
                      hasChanges: () => instructionCopies.hasChanges({ companyId: agent.companyId, runId: run.id, target: executionTarget }),
                      collectStopped: collectStoppedInstructions,
                    } : undefined,

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
                      await persistRunProcessMetadata(run.id, meta);
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
        const processCancellation =
          processRunCancellationSettlements.get(run.id) ??
          failedProcessRunCancellations.get(run.id);
        await processCancellation?.settled;
        let outcome: RunSessionOutcome;
        const latestRun = await getRun(run.id);
        if (isHeartbeatRunTerminalStatus(latestRun?.status)) {
          outcome = latestRun.status;
        } else if (executionControl.controller.signal.aborted) {
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
          (adapterResult.exitCode ?? 0) === 0 &&
          !adapterResult.errorMessage &&
          !adapterResult.signal &&
          !processCancellation?.failed
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
            providerTraceFinalized = true;
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
          stdoutExcerpt,
          stderrExcerpt,
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
            } else if (
              issueId &&
              !skipRunIssueComment &&
              presentationDecision.commentAction === "reuse" &&
              presentationDecision.commentId
            ) {
              await acknowledgeReusedChatCompletionReply(db, {
                companyId: livenessRun.companyId,
                issueId,
                runId: livenessRun.id,
                commentId: presentationDecision.commentId,
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

        const stoppedDuringFailure = executionControl.controller.signal.aborted;
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
          stdoutExcerpt,
          stderrExcerpt,
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

  async function releaseIssueExecutionAndPromote(
    run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">,
    options: { suppressImmediateRecovery?: boolean } = {},
  ) {
    try {
      const source = await getRun(run.id);
      const { postCommitEffects } = await wakeQueue.releaseIssueExecution({
        companyId: run.companyId,
        runId: run.id,
        now: new Date(),
        // A durable authentication card owns recovery. This covers the review path,
        // while continuation classification blocks periodic generic retries.
        suppressImmediateRecovery: options.suppressImmediateRecovery || isAiAuthenticationBlocked(source),
      });
      await applyWakeQueuePostCommitEffects(postCommitEffects);
      const completed = await getRun(run.id);
      const issueId = readNonEmptyString(completed?.contextSnapshot?.issueId)
        ?? readNonEmptyString(completed?.contextSnapshot?.taskId) ?? completed?.nativeIssueId;
      if (completed?.status === "succeeded" && issueId) {
        await settleSlackConversation(db, run.companyId, issueId).catch((err) => {
          logger.warn({ err, runId: run.id }, "Slack conversation settlement deferred to reconciliation");
        });
      }
    } catch (error) {
      if (
        error instanceof WakeQueueApplicationError &&
        error.code === "responsible_user_unresolved"
      ) {
        // Every other `responsible_user_unresolved` HttpError in this file
        // carries `code` inside its own `details`; match that shape here too.
        throw new HttpError(422, error.message, { code: error.code, ...error.details });
      }
      throw error;
    }
  }

  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}, executionWaitRequestId?: string) {
    const source = opts.source ?? "on_demand";
    const triggerDetail = opts.triggerDetail ?? null;
    const contextSnapshot: Record<string, unknown> = {
      ...(opts.contextSnapshot ?? {}),
    };
    const reason = opts.reason ?? null;
    let payload = opts.payload ? { ...opts.payload } : null;
    // Only the board queue route can record interruption authority on an
    // existing receipt. Never accept this internal marker from a wake caller.
    if (payload) {
      delete payload.queuedCommentInterrupt;
      delete payload.manualUserWake;
    }
    if (opts.manualUserWake) {
      if (opts.requestedByActorType !== "user" || !opts.requestedByActorId || opts.failedRunId) {
        throw new HttpError(403, "Manual wake requires an authenticated user");
      }
      payload = { ...payload, manualUserWake: true };
    }
    const executionReconciliationWake =
      contextSnapshot.source === "execution.reconciled" ||
      opts.idempotencyKey?.startsWith("execution-reconciliation:") === true;
    const {
      contextSnapshot: enrichedContextSnapshot,
      issueIdFromPayload,
      taskKey,
      wakeCommentId,
    } = enrichWakeContextSnapshot({
      contextSnapshot,
      reason,
      source,
      triggerDetail,
      payload,
    });
    // Keep each request's own server-derived origin, including coalesced wakes.
    // A run's merged context cannot establish which caller authored one receipt.
    // Overwrite caller-supplied nested context rather than trusting it.
    payload = { ...payload, [DEFERRED_WAKE_CONTEXT_KEY]: { ...enrichedContextSnapshot } };
    let issueId =
      readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;
    if (executionReconciliationWake && !issueId) return null;

    let agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");
    // Mentions only annotate comments. Ignore legacy callers before creating
    // a run or deferred request; assignment and review have their own wakes.
    if (reason === "issue_comment_mentioned" || enrichedContextSnapshot.wakeReason === "issue_comment_mentioned") return null;
    if (issueId) {
      const conversation = await getIssueExecutionContext(agent.companyId, issueId);
      if (reason === "issue_children_completed" && conversation?.originKind === "onboarding_first_task") enrichedContextSnapshot.onboardingCompletion = true;
      if (isConversation(conversation)) {
        if (opts.manualUserWake && conversation!.conversationUserId !== opts.requestedByActorId) {
          throw new HttpError(403, "Only the conversation owner can start a chat run");
        }
        if (isConversationExecutionWake(conversation, reason ?? readNonEmptyString(enrichedContextSnapshot.wakeReason))) return null;
        if (agent.id !== conversation!.conversationAgentId) return null;
        if (!(await instanceSettings.getExperimental()).enableAgentChat) return null;
        if (!wakeCommentId && isWaitingConversation(conversation) && !hasInteractionContinuationWakeContext(enrichedContextSnapshot) && reason !== CHAT_COMPLETION_WAKE_REASON) return null;
      }
    }
    if (agent.adapterType === "paperclip_runner") {
      const oldConfig = parseObject(agent.adapterConfig);
      const nextConfig = normalizeLegacyRunnerProvider(oldConfig);
      if (nextConfig !== oldConfig) {
        await agentService(db).update(
          agent.id,
          { adapterConfig: nextConfig },
          {
            recordRevision: {
              source: "normalize_runner_provider",
              createdByAgentId: null,
              createdByUserId: null,
            },
          },
        );
        await logActivity(db, {
          companyId: agent.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: "agent.updated",
          entityType: "agent",
          entityId: agent.id,
          details: { provider: "codex", reason: "native_codex_provider" },
        });
        agent = (await getAgent(agentId))!;
      }
    }

    if (opts.failedRunId) {
      const failed = await getRun(opts.failedRunId, { includeExecutionEvidence: true });
      if (opts.requestedByActorType !== "user" || !opts.requestedByActorId ||
          reason !== "retry_failed_run" || source !== "on_demand" || triggerDetail !== "manual" ||
          !failed || failed.companyId !== agent.companyId || failed.agentId !== agentId ||
          !(await canRetryStoppedRun(db, failed)) ||
          (failed.nativeIssueId ?? readNonEmptyString(failed.contextSnapshot?.issueId)) !== issueId) {
        throw conflict("The selected failed run cannot be retried for this task.");
      }
      if (!activeRunExecutions.has(failed.id) && !adapterExecutionControls.has(failed.id)) {
        await sweepPendingCleanupLeases({ explicitRetry: {
          companyId: failed.companyId, runId: failed.id, actorId: opts.requestedByActorId,
        } });
      }
      if (isConversationAdapter(agent.adapterType) || agent.adapterType === "paperclip_runner") {
        enrichedContextSnapshot.previousRunId = failed.id;
        enrichedContextSnapshot.forceFreshSession = true;
      }
    }

    const durableRequest = opts.durableChatRequest;
    if (durableRequest) {
      assertDurableChatWakeupRequest(durableRequest, {
        agentId,
        companyId: agent.companyId,
        issueId,
        commentId: wakeCommentId ?? null,
        requestedByActorType: opts.requestedByActorType,
        requestedByActorId: opts.requestedByActorId,
      });
      opts = { ...opts, idempotencyKey: durableRequest.idempotencyKey };
    }
    if (
      Object.hasOwn(enrichedContextSnapshot, "chatFailedRunRetry") &&
      !durableRequest?.failedRunRetry
    ) {
      throw new FailedChatRunRetryAuthorizationError();
    }
    if (durableRequest?.failedRunRetry) {
      opts = { ...opts, allowRunCoalescing: false };
    }
    const dotRequest = opts.durableDotRequest;
    if (dotRequest && (durableRequest || dotRequest.agentId !== agentId ||
        dotRequest.companyId !== agent.companyId || dotRequest.issueId !== issueId ||
        dotRequest.requestId !== payload?.dotRequestId || source !== "assignment" ||
        opts.requestedByActorType !== "agent" || opts.requestedByActorId !== agentId ||
        agent.adapterType !== "paperclip_runner" || parseObject(agent.adapterConfig).provider !== "openai_dot" ||
        opts.idempotencyKey !== dotRequest.idempotencyKey)) {
      throw conflict("Dot work request does not match its admission authority.");
    }
    const receiptRequest = durableRequest ?? dotRequest;
    const durableReceiptFields = receiptRequest
      ? { id: receiptRequest.id, requestedAt: receiptRequest.requestedAt }
      : {};
    const existingDurableReceipt = async (queryDb: Db) => {
      if (!receiptRequest) return null;
      const receipt = await queryDb
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, receiptRequest.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (receipt && durableRequest) assertDurableChatWakeupReceipt(durableRequest, receipt);
      if (receipt && dotRequest && (receipt.companyId !== dotRequest.companyId ||
          receipt.agentId !== dotRequest.agentId || receipt.source !== "assignment" ||
          receipt.requestedByActorType !== "agent" || receipt.requestedByActorId !== dotRequest.agentId ||
          receipt.idempotencyKey !== dotRequest.idempotencyKey || receipt.payload?.issueId !== dotRequest.issueId ||
          receipt.payload?.dotRequestId !== dotRequest.requestId)) {
        throw conflict("requestId was reused for another task.");
      }
      return receipt;
    };
    const priorReceipt = await existingDurableReceipt(db);
    if (priorReceipt) {
      // Replaying an admission receipt is not fresh authority to dispatch it.
      // The normal queue owns dispatch and its current execution-policy checks.
      return priorReceipt.runId ? getRun(priorReceipt.runId) : null;
    }

    const agentDebug = parseObject(parseObject(agent.runtimeConfig).debug);
    const runDebug = parseObject(enrichedContextSnapshot.debug);
    if (
      agentDebug.providerTrace === "raw" &&
      runDebug.providerTrace !== "raw"
    ) {
      enrichedContextSnapshot.debug = {
        ...runDebug,
        providerTrace: "raw",
      };
      enrichedContextSnapshot.providerTraceRequestedBy = `agent:${agent.id}:debug-setting`;
      enrichedContextSnapshot.providerTraceRequestSource =
        "agent_debug_setting";
    }

    // Automatic signals are replaceable; user input and interaction delivery
    // retain distinct durable receipts even when the same gate blocks them.
    const coalesceExecutionWait =
      opts.requestedByActorType === "system" &&
      !receiptRequest &&
      !wakeCommentId &&
      queuedCommentIdsFromRunContext(enrichedContextSnapshot).length === 0 &&
      !isInteractionResolutionWakePayload(payload ?? {}) &&
      !hasInteractionContinuationWakeContext(enrichedContextSnapshot);
    const writeSkippedRequest = async (
      skipReason: string,
      patch: Partial<typeof agentWakeupRequests.$inferInsert> = {},
      waitCondition?: Record<string, unknown>,
    ) => {
      if (executionWaitRequestId) {
        await db.update(agentWakeupRequests).set({
          payload: sql`jsonb_set(coalesce(${agentWakeupRequests.payload}, '{}'::jsonb), '{executionWait}',
            coalesce(${agentWakeupRequests.payload}->'executionWait', '{}'::jsonb) || ${JSON.stringify({
              reason: skipReason, message: patch.error ?? (skipReason === "issue_tree_hold_active"
                ? "This task is paused. Resume it to send your saved message."
                : "Waiting for task execution to be enabled. Your message is saved."),
            })}::jsonb)`,
          updatedAt: new Date(),
        }).where(and(eq(agentWakeupRequests.id, executionWaitRequestId),
          eq(agentWakeupRequests.companyId, agent.companyId), eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution")));
        return { created: false };
      }
      const request = {
        ...durableReceiptFields,
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason: skipReason,
        payload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        finishedAt: new Date(),
        ...patch,
      };
      if (waitCondition && issueId && isUuidLike(issueId)) {
        const waitIssueId = issueId;
        return db.transaction(async (tx) => {
          await tx.execute(sql`select id from issues where id = ${waitIssueId} and company_id = ${agent.companyId} for update`);
          return recordExecutionWait(tx as unknown as Db, {
            issueId: waitIssueId, request, condition: waitCondition, coalesce: coalesceExecutionWait,
          });
        });
      }
      await db.insert(agentWakeupRequests).values(request);
      return { created: true };
    };
    const writeSkippedHeartbeatRequest = async (
      skipReason: string,
      details: Record<string, unknown>,
    ) => {
      await writeSkippedRequest(skipReason, {
        payload: {
          ...(payload ?? {}),
          heartbeatSkip: details,
        },
      });
    };

    const schedulingSuppression = await getSchedulingSuppression();
    // A task drain holds ADMISSION, not the request. The drain is a
    // process-local pre-restart hold, so a wake that arrives while it is
    // active still names real work that must run once the process comes
    // back: leave it in the durable queue and let the dispatch-side checks
    // (startNextQueuedRunForAgent / executeRun) keep it from starting until
    // the drain lifts or the restart clears it. Writing it as `skipped`
    // here dropped the wake permanently — an accepted plan whose
    // continuation wake landed mid-drain left its issue in `todo` with no
    // run and no path until a person noticed.
    if (
      schedulingSuppression.suppressed &&
      schedulingSuppression.reason !== "task_drain"
    ) {
      await writeSkippedHeartbeatRequest("heartbeat.scheduling_suppressed", {
        reason: schedulingSuppression.reason,
      });
      return null;
    }

    const worktreeExecutionCutoff =
      opts.requestedByActorType === "user"
        ? null
        : await getWorktreeExecutionCutoff();

    const company = await db
      .select({ status: companies.status })
      .from(companies)
      .where(eq(companies.id, agent.companyId))
      .then((rows) => rows[0] ?? null);

    if (!company || company.status !== "active") {
      const companyStatus = company?.status ?? "missing";
      if (opts.requestedByActorType === "user") {
        throw conflict("Company is not active", { status: companyStatus });
      }
      await writeSkippedRequest("company.inactive", {
        error: `Wake suppressed because company status is ${companyStatus}`,
      }, { companyStatus });
      return null;
    }

    const explicitResumeSession = await resolveExplicitResumeSessionOverride(
      agent,
      payload,
      taskKey,
    );
    if (explicitResumeSession) {
      enrichedContextSnapshot.resumeFromRunId =
        explicitResumeSession.resumeFromRunId;
      enrichedContextSnapshot.resumeSessionDisplayId =
        explicitResumeSession.sessionDisplayId;
      enrichedContextSnapshot.resumeSessionParams =
        explicitResumeSession.sessionParams;
      if (
        !readNonEmptyString(enrichedContextSnapshot.issueId) &&
        explicitResumeSession.issueId
      ) {
        enrichedContextSnapshot.issueId = explicitResumeSession.issueId;
      }
      if (
        !readNonEmptyString(enrichedContextSnapshot.taskId) &&
        explicitResumeSession.taskId
      ) {
        enrichedContextSnapshot.taskId = explicitResumeSession.taskId;
      }
      if (
        !readNonEmptyString(enrichedContextSnapshot.taskKey) &&
        explicitResumeSession.taskKey
      ) {
        enrichedContextSnapshot.taskKey = explicitResumeSession.taskKey;
      }
      issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueId;
    }
    const effectiveTaskKey =
      readNonEmptyString(enrichedContextSnapshot.taskKey) ?? taskKey;
    const sessionBefore =
      explicitResumeSession?.sessionDisplayId ??
      (await resolveSessionBeforeForWakeup(agent, effectiveTaskKey));
    let hasResolvablePriorSessionWorkspace: boolean | null = null;
    const resolveHasResolvablePriorSessionWorkspace = async () => {
      if (hasResolvablePriorSessionWorkspace !== null)
        return hasResolvablePriorSessionWorkspace;
      hasResolvablePriorSessionWorkspace = issueId
        ? await hasResolvablePriorSessionWorkspaceForWake({
            agent,
            contextSnapshot: enrichedContextSnapshot,
            taskKey: effectiveTaskKey,
            explicitResumeSession,
          })
        : false;
      return hasResolvablePriorSessionWorkspace;
    };
    const continuationAttempt = readContinuationAttempt(
      enrichedContextSnapshot.livenessContinuationAttempt,
    );

    let projectId = readNonEmptyString(enrichedContextSnapshot.projectId);
    if (!projectId && issueId) {
      // Look up by either UUID or identifier (e.g. "ENV-13"), but always scope
      // by companyId so a row from another tenant can never be returned even
      // when identifiers collide across companies. Guard the UUID arm because
      // issues.id is a Postgres uuid column — passing "ENV-13" into eq(issues.id, …)
      // would fail with an invalid-input-syntax cast error before the OR is
      // evaluated.
      const lookupIsUuid = isUuidLike(issueId);
      const idMatch = lookupIsUuid
        ? or(
            eq(issues.id, issueId),
            eq(issues.identifier, issueId.toUpperCase()),
          )
        : eq(issues.identifier, issueId.toUpperCase());
      const resolvedIssue = await db
        .select({
          id: issues.id,
          projectId: issues.projectId,
          createdAt: issues.createdAt,
        })
        .from(issues)
        .where(and(eq(issues.companyId, agent.companyId), idMatch))
        .then((rows) => rows[0] ?? null);
      if (resolvedIssue) {
        if (
          worktreeExecutionCutoff &&
          resolvedIssue.createdAt < worktreeExecutionCutoff
        ) {
          await writeSkippedHeartbeatRequest(
            "heartbeat.worktree_execution_cutoff",
            {
              reason: "worktree_execution_cutoff",
              cutoff: worktreeExecutionCutoff.toISOString(),
              issueId: resolvedIssue.id,
            },
          );
          return null;
        }
        projectId = resolvedIssue.projectId ?? null;
        // Canonicalize context to the UUID so downstream lookups always use UUID
        if (resolvedIssue.id !== issueId) {
          issueId = resolvedIssue.id;
          enrichedContextSnapshot.issueId = issueId;
          if (readNonEmptyString(enrichedContextSnapshot.taskId)) {
            enrichedContextSnapshot.taskId = issueId;
          }
        }
      }
    }
    // Propagate projectId into context so resolveWorkspaceForRun can bind the
    // project workspace even when context.projectId wasn't set by the caller.
    if (projectId && !readNonEmptyString(enrichedContextSnapshot.projectId)) {
      enrichedContextSnapshot.projectId = projectId;
    }
    const isolatedWorkspacesEnabled = issueId
      ? (await instanceSettings.getExperimental()).enableIsolatedWorkspaces
      : false;
    let operatorResponsibleUserId: string | null = opts.manualUserWake ? opts.requestedByActorId! : null;
    let queuedResponsibleUserIdPromise: Promise<string> | null = null;
    const resolveQueuedResponsibleUserId = () => {
      if (operatorResponsibleUserId) return Promise.resolve(operatorResponsibleUserId);
      queuedResponsibleUserIdPromise ??= (async () => {
        const queuedIssueContext = issueId
          ? await getIssueExecutionContext(agent.companyId, issueId)
          : null;
        const queuedRoutineEnvContext = await getRoutineEnvForExecutionIssue(
          agent.companyId,
          queuedIssueContext,
        );
        const queuedResponsibleUserId =
          await resolveResponsibleUserIdForRunSeed({
            companyId: agent.companyId,
            contextSnapshot: enrichedContextSnapshot,
            issueContext: queuedIssueContext,
            routineEnvContext: queuedRoutineEnvContext,
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            source,
            triggerDetail,
          });
        if (!queuedResponsibleUserId) {
          throw new HttpError(
            422,
            "Unable to resolve responsible user for heartbeat run dispatch",
            {
              code: "responsible_user_unresolved",
              agentId,
              companyId: agent.companyId,
              issueId: issueId ?? null,
              source,
              triggerDetail,
              wakeReason: readNonEmptyString(
                enrichedContextSnapshot.wakeReason,
              ),
            },
          );
        }
        return queuedResponsibleUserId;
      })();
      return queuedResponsibleUserIdPromise;
    };

    const budgetBlock = await budgets.getInvocationBlock(
      agent.companyId,
      agentId,
      {
        issueId,
        projectId,
      },
    );
    if (budgetBlock) {
      await writeSkippedRequest("budget.blocked", { error: budgetBlock.reason }, {
        scopeType: budgetBlock.scopeType, scopeId: budgetBlock.scopeId,
      });
      throw conflict(budgetBlock.reason, {
        scopeType: budgetBlock.scopeType,
        scopeId: budgetBlock.scopeId,
      });
    }

    const invokability = await getAgentInvokability(agent);
    if (!invokability.invokable) {
      if (opts.requestedByActorType !== "user" || executionWaitRequestId) {
        await writeSkippedRequest("agent.not_invokable", {
          error: invokability.message,
        }, { status: agent.status, reason: invokability.reason });
      }
      throw conflict(invokability.message, {
        status: agent.status,
        reason: invokability.reason,
        invalidOrgChain: invokability.invalidOrgChain,
        ...invokability.details,
      });
    }

    const policy = parseHeartbeatPolicy(agent);

    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled", {}, { enabled: false });
      return null;
    }
    if (source !== "timer" && !policy.wakeOnDemand) {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled", {}, { wakeOnDemand: false });
      return null;
    }

    const genericTimerWake =
      source === "timer" &&
      !issueId &&
      !wakeCommentId &&
      !readNonEmptyString(enrichedContextSnapshot.taskId) &&
      !readNonEmptyString(enrichedContextSnapshot.taskKey);
    if (
      policy.skipTimerWhenNoActionableWork &&
      genericTimerWake &&
      !(await hasActionableTimerWork(agent))
    ) {
      await writeSkippedHeartbeatRequest("heartbeat.timer.no_actionable_work", {
        reason:
          "No assigned todo or in_progress issue requires this agent before timer adapter invocation.",
      });
      await markTimerHeartbeatChecked(agentId, source);
      return null;
    }

    if (issueId) {
      const activePauseHold = await treeControlSvc.getActivePauseHoldGate(
        agent.companyId,
        issueId,
      );
      if (activePauseHold) {
        const treeHoldInteractionWake =
          await isVerifiedIssueTreeControlInteractionWake(db, {
            companyId: agent.companyId,
            issueId,
            agentId,
            contextSnapshot: enrichedContextSnapshot,
            requestedByActorType: opts.requestedByActorType,
            requestedByActorId: opts.requestedByActorId,
          });

        if (!treeHoldInteractionWake) {
          const wait = await writeSkippedRequest("issue_tree_hold_active", {}, {
            holdId: activePauseHold.holdId,
          });
          if (wait.created) await logActivity(db, {
            companyId: agent.companyId,
            actorType: "system",
            actorId: "system",
            agentId,
            runId: null,
            action: "issue.tree_hold_wakeup_deferred",
            entityType: "issue",
            entityId: issueId,
            details: {
              holdId: activePauseHold.holdId,
              rootIssueId: activePauseHold.rootIssueId,
              requestedReason: reason,
              source,
              triggerDetail,
              securityPrinciples: [
                "Complete Mediation",
                "Fail Securely",
                "Secure Defaults",
              ],
            },
          });
          return null;
        }

        enrichedContextSnapshot.treeHoldInteraction = true;
        enrichedContextSnapshot.activeTreeHold = {
          holdId: activePauseHold.holdId,
          rootIssueId: activePauseHold.rootIssueId,
          mode: activePauseHold.mode,
          reason: activePauseHold.reason,
          releasePolicy: activePauseHold.releasePolicy,
          interaction: true,
        };
      }
    }

    if (issueId) {
      // Mention-triggered wakes can request input from another agent, but they must
      // still respect the issue execution lock so a second agent cannot start on the
      // same issue workspace while the assignee already has a live run.
      const agentNameKey = normalizeAgentNameKey(agent.name);

      const cancelledRunsToEmit: (typeof heartbeatRuns.$inferSelect)[] = [];

      const outcome = await db
        .transaction(async (tx) => {
          await tx.execute(
            sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
          );

          if (executionWaitRequestId) {
            const [pending] = await tx.select().from(agentWakeupRequests).where(and(
              eq(agentWakeupRequests.id, executionWaitRequestId), eq(agentWakeupRequests.companyId, agent.companyId),
              eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
              // A user message can join a queue originally created by a
              // system wake. Admission validates the saved user comment or board click.
              (opts.queuedCommentInterruptId ?? opts.queuedCommentRequestId) === executionWaitRequestId
                ? undefined : eq(agentWakeupRequests.requestedByActorType, "user"),
              opts.queuedCommentInterruptId === executionWaitRequestId
                ? sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt'->>'actorId' = ${opts.requestedByActorId ?? ""}`
                : opts.queuedCommentRequestId === executionWaitRequestId ? undefined
                  : eq(agentWakeupRequests.requestedByActorId, opts.requestedByActorId ?? ""),
              sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
            ));
            // The issue lock serializes cleanup callbacks and periodic workers.
            // An adopted, discarded, or edited receipt is no longer authority.
            if (!pending || (!(wakeCommentId && queuedCommentIdsFromWakePayload(pending.payload).includes(wakeCommentId)) &&
                !(opts.queuedCommentInterruptId && await readQueuedInteractionResponse(tx as unknown as Db,
                  agent.companyId, issueId, pending.payload)))) {
              return { kind: "deferred" as const };
            }
            if (opts.queuedCommentRequestId) {
              const ids = await undeliveredLegacyUserCommentIds(tx as unknown as Db,
                agent.companyId, issueId, agentId, queuedCommentIdsFromWakePayload(pending.payload));
              if (!wakeCommentId || !ids.includes(wakeCommentId)) return { kind: "deferred" as const };
              pending.payload = withQueuedCommentIdsInWakePayload(parseObject(pending.payload), ids);
              await tx.update(agentWakeupRequests).set({ payload: pending.payload }).where(and(
                eq(agentWakeupRequests.id, pending.id), eq(agentWakeupRequests.companyId, agent.companyId),
              ));
            }
            if (!opts.queuedCommentInterruptId && !opts.queuedCommentRequestId && pending.payload?.manualUserWake === true) {
              // A persisted manual wake keeps its actor when an execution wait
              // resumes. The locked receipt above has revalidated that actor.
              payload = { ...payload, manualUserWake: true };
              operatorResponsibleUserId = opts.requestedByActorId!;
            }
            if (opts.queuedCommentInterruptId) {
              // The locked board receipt supplies execution authority even when
              // another user authored the messages. Dispatch revalidates the receipt.
              operatorResponsibleUserId = opts.requestedByActorId!;
            }
            if (opts.queuedCommentInterruptId || opts.queuedCommentRequestId) {
              // Edits/discards between the click and dispatch remain authoritative.
              Object.assign(enrichedContextSnapshot, withQueuedCommentIdsInRunContext(
                enrichedContextSnapshot, queuedCommentIdsFromWakePayload(pending.payload),
              ));
            }
          }
          let automaticParentRunId: string | null = null;
          if (
            source === "automation" &&
            opts.requestedByActorType === "system"
          ) {
            const nativeParent = await readChatControlNativeParent(
              tx as unknown as Db,
              { companyId: agent.companyId, issueId, agentId },
              opts.requestedByActorId ?? null,
            );
            const genericParent =
              !opts.requestedByActorId && reason === "issue_continuation_needed"
                ? readNonEmptyString(enrichedContextSnapshot.retryOfRunId)
                : null;
            automaticParentRunId =
              nativeParent.kind === "parent"
                ? nativeParent.runId
                : genericParent;
            if (automaticParentRunId) {
              const [parent] = await tx
                .select({
                  agentId: heartbeatRuns.agentId,
                  context: heartbeatRuns.contextSnapshot,
                })
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.companyId, agent.companyId),
                    eq(heartbeatRuns.id, automaticParentRunId),
                  ),
                )
                .limit(1);
              if (
                parent &&
                (parseObject(parent.context).issueId ??
                  parseObject(parent.context).taskId) === issueId &&
                parent.agentId !== agentId
              )
                automaticParentRunId = null;
            }
            const proof =
              nativeParent.kind === "unresolved"
                ? { kind: "unresolved" as const }
                : automaticParentRunId
                  ? await readChatControlRecoveryStop(
                      tx as unknown as Db,
                      {
                        companyId: agent.companyId,
                        issueId,
                        agentId,
                        sourceRunId: automaticParentRunId,
                      },
                      true,
                    )
                  : { kind: "clear" as const };
            if (proof.kind !== "clear") {
              await tx
                .insert(agentWakeupRequests)
                .values({
                  companyId: agent.companyId,
                  agentId,
                  source,
                  triggerDetail,
                  reason:
                    proof.kind === "stopped"
                      ? CHAT_CONTROL_RECOVERY_STOP_CODE
                      : CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
                  payload: { issueId },
                  status: "skipped",
                  requestedByActorType: "system",
                  requestedByActorId: opts.requestedByActorId ?? null,
                  idempotencyKey: opts.idempotencyKey ?? null,
                  finishedAt: new Date(),
                });
              return { kind: "skipped" as const };
            }
          }

          const durableReceipt = await existingDurableReceipt(
            tx as unknown as Db,
          );
          if (durableReceipt)
            return { kind: "durable" as const, receipt: durableReceipt };
          const failedChatRetry = await authorizeFailedChatRunRetryWake(
            db,
            tx as unknown as Db,
            {
              phase: "admission",
              wakeupRequestId: durableRequest?.id ?? null,
              companyId: agent.companyId,
              agentId,
              issueId,
              contextSnapshot: enrichedContextSnapshot,
            },
          );
          if (
            failedChatRetry !== Boolean(durableRequest?.failedRunRetry) ||
            (failedChatRetry &&
              durableRequest?.failedRunRetry?.failedRunId !==
                readNonEmptyString(enrichedContextSnapshot.retryOfRunId))
          ) {
            throw new FailedChatRunRetryAuthorizationError();
          }
          if (durableRequest) {
            if (issueId !== durableRequest.issueId)
              throw new Error("chat_inbound_wakeup_binding_denied");
            await durableRequest.authorize(tx as unknown as Db);
          } else {
            if (
              source === "on_demand" &&
              triggerDetail === "manual" &&
              reason === "retry_failed_run"
            ) {
              // Generic Board retry does not carry server-authorized failed-run
              // lineage. Caller-supplied source/comment/retry markers cannot
              // restore it, including for a retired conversation generation.
              const [chatBinding] = await tx
                .select({ id: chatConversations.id })
                .from(chatConversations)
                .innerJoin(chatEndpoints, eq(chatEndpoints.id, chatConversations.endpointId))
                .where(
                  and(
                    eq(chatEndpoints.externalExecutionPolicy, "restricted"),
                    eq(chatConversations.companyId, agent.companyId),
                    eq(chatConversations.issueId, issueId),
                  ),
                )
                .limit(1);
              if (chatBinding) {
                throw conflict(
                  "Retry needs the exact failed chat request and current access. Send the request again in the current connected conversation.",
                  { code: "chat_failed_run_retry_requires_authorized_context" },
                );
              }
            }
            const [held] = await tx
              .select({ id: issues.id })
              .from(issues)
              .where(
                and(
                  eq(issues.id, issueId),
                  eq(issues.companyId, agent.companyId),
                  unadmittedChatWakeupCondition(issues.id, issues.companyId),
                ),
              )
              .limit(1);
            if (held) {
              throw conflict(
                "This task has external chat input that has not been admitted. Check the connection's Activity; let pending input finish, or restore access and send a new authorized message before starting the task.",
                { code: "chat_inbound_wakeup_unadmitted", issueId },
              );
            }
          }

          const issue = await tx
            .select({
              id: issues.id,
              companyId: issues.companyId,
              identifier: issues.identifier,
              conversationAgentId: issues.conversationAgentId,
              conversationUserId: issues.conversationUserId,
              conversationState: issues.conversationState,
              status: issues.status,
              statusVersion: issues.statusVersion,
              projectId: issues.projectId,
              projectWorkspaceId: issues.projectWorkspaceId,
              executionWorkspaceId: issues.executionWorkspaceId,
              executionWorkspacePreference: issues.executionWorkspacePreference,
              executionWorkspaceSettings: issues.executionWorkspaceSettings,
              assigneeAgentId: issues.assigneeAgentId,
              assigneeUserId: issues.assigneeUserId,
              monitorNextCheckAt: issues.monitorNextCheckAt,
              monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
              executionRunId: issues.executionRunId,
              executionAgentNameKey: issues.executionAgentNameKey,
              createdAt: issues.createdAt,
            })
            .from(issues)
            .where(
              and(
                eq(issues.id, issueId),
                eq(issues.companyId, agent.companyId),
              ),
            )
            .then((rows) => rows[0] ?? null);

          if (!issue) {
            await tx.insert(agentWakeupRequests).values({
              ...durableReceiptFields,
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_execution_issue_not_found",
              payload,
              status: "skipped",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              finishedAt: new Date(),
            });
            return { kind: "skipped" as const };
          }

          const issueStateGuard = opts.issueStateGuard;
          const activeMonitorRun = issueStateGuard?.monitorNextCheckAt === undefined ? null
            : await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
              eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.nativeIssueId, issue.id),
              eq(heartbeatRuns.runtimeMode, "native"), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
            )).limit(1).then(rows => rows[0] ?? null);
          if (
            issueStateGuard &&
            (!issueStateGuard.statuses.includes(issue.status) ||
              issue.assigneeAgentId !== issueStateGuard.assigneeAgentId ||
              (issueStateGuard.statusVersion !== undefined && issue.statusVersion !== issueStateGuard.statusVersion) ||
              (issueStateGuard.monitorNextCheckAt !== undefined && (
                activeMonitorRun !== null || issue.assigneeUserId !== null ||
                issue.monitorNextCheckAt?.toISOString() !== issueStateGuard.monitorNextCheckAt ||
                issue.monitorWakeRequestedAt?.toISOString() !== issueStateGuard.monitorWakeRequestedAt
              )))
          ) {
            // A deferred monitor retains its schedule; do not create a receipt
            // that could suppress its next admission attempt.
            if (issueStateGuard.monitorNextCheckAt !== undefined) return { kind: "skipped" as const };
            await tx.insert(agentWakeupRequests).values({
              ...durableReceiptFields,
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_state_guard_mismatch",
              payload: {
                ...(payload ?? {}),
                heartbeatSkip: {
                  reason:
                    "Issue status or assignee changed before the wake could be queued.",
                  issueId: issue.id,
                  expectedStatuses: issueStateGuard.statuses,
                  actualStatus: issue.status,
                  expectedAssigneeAgentId: issueStateGuard.assigneeAgentId,
                  actualAssigneeAgentId: issue.assigneeAgentId,
                },
              },
              status: "skipped",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              finishedAt: new Date(),
            });
            return { kind: "skipped" as const };
          }

          if (opts.failedRunId) {
            // The issue lock makes double-clicks and network retries adopt the
            // same successor, including after it has already finished.
            const [previousRetry] = await tx.select().from(heartbeatRuns).where(and(
              eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.agentId, agentId),
              eq(heartbeatRuns.retryOfRunId, opts.failedRunId),
              sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = 'retry_failed_run'`,
            )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
            if (previousRetry) return { kind: "replayed" as const, run: previousRetry };
          }

          let reconciledSourceRunId: string | null = null;
          let reconciledRestoreRetryCount: number | null = null;
          if (executionReconciliationWake) {
            const actionId = readNonEmptyString(
              enrichedContextSnapshot.recoveryActionId,
            );
            if (
              !actionId ||
              !isUuidLike(actionId) ||
              source !== "automation" ||
              triggerDetail !== "system" ||
              reason !== "issue_recovery_action_restored" ||
              opts.requestedByActorType !== "system" ||
              opts.requestedByActorId !== "execution-recovery" ||
              opts.idempotencyKey !== `execution-reconciliation:${actionId}` ||
              enrichedContextSnapshot.source !== "execution.reconciled" ||
              enrichedContextSnapshot.forceFreshSession !== true ||
              payload?.issueId !== issue.id ||
              payload?.recoveryActionId !== actionId ||
              issue.assigneeAgentId !== agentId ||
              ["done", "cancelled"].includes(issue.status)
            )
              return { kind: "skipped" as const };

            // The issue lock serializes all admissions for this source. Validate
            // the durable operator decision, then reconcile a prior queue commit
            // before considering a new wake (including a now-terminal successor).
            const [action] = await tx
              .select()
              .from(issueRecoveryActions)
              .where(
                and(
                  eq(issueRecoveryActions.companyId, issue.companyId),
                  eq(issueRecoveryActions.sourceIssueId, issue.id),
                  eq(issueRecoveryActions.id, actionId),
                ),
              )
              .for("update");
            const decision = parseObject(
              action?.evidence.executionReconciliation,
            );
            const sourceRunId = readNonEmptyString(decision.runId);
            if (
              !action ||
              action.status !== "resolved" ||
              action.kind !== "active_run_watchdog" ||
              action.returnOwnerAgentId !== agentId ||
              !sourceRunId ||
              !isUuidLike(sourceRunId) ||
              decision.providerStopped !== true ||
              !["completed", "not_performed", "mixed"].includes(
                String(decision.actionOutcome),
              ) ||
              !readNonEmptyString(decision.outcomeEvidence) ||
              enrichedContextSnapshot.previousRunId !== sourceRunId ||
              enrichedContextSnapshot.retryOfRunId !== sourceRunId ||
              !["pending", "delivered"].includes(
                String(action.evidence.continuationDelivery),
              )
            )
              return { kind: "skipped" as const };

            const [existingWake] = await tx
              .select()
              .from(agentWakeupRequests)
              .where(
                and(
                  eq(agentWakeupRequests.companyId, issue.companyId),
                  eq(agentWakeupRequests.agentId, agentId),
                  eq(agentWakeupRequests.idempotencyKey, opts.idempotencyKey),
                  ne(agentWakeupRequests.status, "skipped"),
                ),
              )
              .orderBy(asc(agentWakeupRequests.requestedAt))
              .limit(1);
            if (existingWake) {
              if (
                existingWake.payload?.issueId !== issue.id ||
                existingWake.payload?.recoveryActionId !== action.id ||
                existingWake.requestedByActorType !== "system" ||
                existingWake.requestedByActorId !== "execution-recovery" ||
                !existingWake.runId
              )
                return { kind: "deferred" as const };
              const [existingRun] = await tx
                .select()
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.companyId, issue.companyId),
                    eq(heartbeatRuns.agentId, agentId),
                    eq(heartbeatRuns.id, existingWake.runId),
                  ),
                );
              if (
                !existingRun ||
                existingRun.contextSnapshot?.issueId !== issue.id ||
                existingRun.contextSnapshot?.recoveryActionId !== action.id ||
                existingRun.contextSnapshot?.previousRunId !== sourceRunId
              )
                return { kind: "deferred" as const };
              return { kind: "replayed" as const, run: existingRun };
            }
            if (action.evidence.continuationDelivery !== "pending")
              return { kind: "skipped" as const };
            const [reconciledRun] = await tx.select().from(heartbeatRuns).where(and(
              eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.id, sourceRunId),
            ));
            if (hasWorkspaceRestoreFailure(reconciledRun?.resultJson)) {
              if ((readNonEmptyString(decision.workspaceRepairEvidence)?.length ?? 0) < 20)
                return { kind: "skipped" as const };
              // Repair does not reset the remaining automatic retry budget.
              reconciledRestoreRetryCount = executionFailureRetryCount(reconciledRun!);
            }
            reconciledSourceRunId = sourceRunId;
          }

          let continuationWait = { reason: "execution_recovery", message: "Waiting for execution recovery. Your message is saved." };
          const deferBlockedExecution = async (
            executionBlocker: NonNullable<Awaited<ReturnType<typeof getExecutionBlocker>>>,
          ) => {
            const condition = { recoveryActionId: executionBlocker.recoveryActionId, ...continuationWait };
            if (executionWaitRequestId) {
              await tx.update(agentWakeupRequests).set({
                payload: sql`jsonb_set(coalesce(${agentWakeupRequests.payload}, '{}'::jsonb), '{executionWait}', ${JSON.stringify(condition)}::jsonb)`,
                updatedAt: new Date(),
              }).where(eq(agentWakeupRequests.id, executionWaitRequestId));
              return { kind: "deferred" as const };
            }
            if (durableRequest || wakeCommentId ||
                hasInteractionContinuationWakeContext(enrichedContextSnapshot) ||
                readNonEmptyString(enrichedContextSnapshot.nativeStatusWakeIntentId)) {
              await tx.insert(agentWakeupRequests).values({
                ...durableReceiptFields,
                companyId: agent.companyId, agentId, source, triggerDetail, reason,
                payload: withQueuedCommentIdsInWakePayload({
                  ...payload,
                  issueId: issue.id,
                  [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
                  executionWait: condition,
                }, [...new Set([
                  ...queuedCommentIdsFromRunContext(enrichedContextSnapshot),
                  ...(wakeCommentId ? [wakeCommentId] : []),
                ])]),
                status: "deferred_issue_execution",
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null,
                idempotencyKey: opts.idempotencyKey ?? null,
              });
            } else {
              await recordExecutionWait(tx as unknown as Db, {
                issueId: issue.id, condition, coalesce: coalesceExecutionWait,
                request: {
                  ...durableReceiptFields,
                  companyId: agent.companyId, agentId, source, triggerDetail,
                  reason: "execution_reconciliation_required",
                  error: executionBlocker.nextAction,
                  payload,
                  requestedByActorType: opts.requestedByActorType ?? null,
                  requestedByActorId: opts.requestedByActorId ?? null,
                  idempotencyKey: opts.idempotencyKey ?? null,
                },
              });
            }
            return { kind: "deferred" as const };
          };
          const explicitContinuationRunId = randomUUID();
          const executionBlocker = await getExecutionBlocker(
            tx as unknown as Db, issue.companyId, issue.id,
            { conversationResetCommentId: opts.requestedByActorType === "user" ? wakeCommentId : null },
          );
          // Prove eligibility without retiring the hold. Later gates can still
          // decline this wake; hold retirement and successor creation stay atomic.
          // A bound chat request has already rechecked its current principal
          // above. Treat its new user message like a board comment, but keep
          // failed-run retry actions on their separate exact-request path.
          if (executionBlocker && !(await admitExplicitNativeContinuation({
            db: tx as unknown as Db, companyId: issue.companyId, issueId: issue.id,
            agentId, actorType: opts.requestedByActorType, actorId: opts.requestedByActorId,
            reason: durableRequest && !failedChatRetry ? "issue_commented" : reason,
            commentId: wakeCommentId ?? null, failedRunId: opts.failedRunId, successorRunId: explicitContinuationRunId,
            queuedCommentInterruptId: opts.queuedCommentInterruptId,
            queuedCommentRequestId: opts.queuedCommentRequestId,
            dryRun: true,
            onBlocked: (reason, message) => { continuationWait = { reason, message }; },
          }))) return deferBlockedExecution(executionBlocker);


          if (
            worktreeExecutionCutoff &&
            issue.createdAt < worktreeExecutionCutoff
          ) {
            await tx.insert(agentWakeupRequests).values({
              ...durableReceiptFields,
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "heartbeat.worktree_execution_cutoff",
              payload: {
                ...(payload ?? {}),
                heartbeatSkip: {
                  reason: "worktree_execution_cutoff",
                  cutoff: worktreeExecutionCutoff.toISOString(),
                  issueId: issue.id,
                },
              },
              status: "skipped",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              finishedAt: new Date(),
            });
            return { kind: "skipped" as const };
          }

          const cancelStaleScheduledRetry = async (
            scheduledRun: typeof heartbeatRuns.$inferSelect,
          ) => {
            const issueCancelled = issue.status === "cancelled";
            if (
              scheduledRun.status !== "scheduled_retry" ||
              (scheduledRun.agentId === issue.assigneeAgentId &&
                !issueCancelled)
            ) {
              return false;
            }

            const now = new Date();
            const reason = issueCancelled
              ? "Cancelled because the issue was cancelled before the scheduled retry became due"
              : "Cancelled because the issue was reassigned before the scheduled retry became due";
            const cancelled = await tx
              .update(heartbeatRuns)
              .set({
                status: "cancelled",
                finishedAt: now,
                error: reason,
                errorCode: issueCancelled
                  ? "issue_cancelled"
                  : "issue_reassigned",
                updatedAt: now,
              })
              .where(
                and(
                  eq(heartbeatRuns.id, scheduledRun.id),
                  eq(heartbeatRuns.status, "scheduled_retry"),
                ),
              )
              .returning()
              .then((rows) => rows[0] ?? null);

            if (!cancelled) return false;

            if (scheduledRun.wakeupRequestId) {
              await tx
                .update(agentWakeupRequests)
                .set({
                  status: "cancelled",
                  finishedAt: now,
                  error: reason,
                  updatedAt: now,
                })
                .where(
                  eq(agentWakeupRequests.id, scheduledRun.wakeupRequestId),
                );
            }

            if (issue.executionRunId === scheduledRun.id) {
              await tx
                .update(issues)
                .set({
                  executionRunId: null,
                  executionAgentNameKey: null,
                  executionLockedAt: null,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(issues.id, issue.id),
                    eq(issues.executionRunId, scheduledRun.id),
                  ),
                );
            }

            const eventSeq = await allocateHeartbeatRunEventSeq(
              tx as unknown as Db,
              cancelled.id,
            );

            await tx.insert(heartbeatRunEvents).values({
              companyId: cancelled.companyId,
              runId: cancelled.id,
              agentId: cancelled.agentId,
              seq: eventSeq,
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: issueCancelled
                ? "Scheduled retry cancelled because issue was cancelled before it became due"
                : "Scheduled retry cancelled because issue ownership changed before it became due",
              payload: {
                issueId: issue.id,
                issueStatus: issue.status,
                scheduledRetryAttempt: cancelled.scheduledRetryAttempt,
                scheduledRetryAt: cancelled.scheduledRetryAt
                  ? new Date(cancelled.scheduledRetryAt).toISOString()
                  : null,
                scheduledRetryReason: cancelled.scheduledRetryReason,
                previousRetryAgentId: cancelled.agentId,
                currentAssigneeAgentId: issue.assigneeAgentId,
              },
            });
            await tx
              .update(heartbeatRuns)
              .set({ nextEventSeq: eventSeq + 1, updatedAt: now })
              .where(eq(heartbeatRuns.id, cancelled.id));

            cancelledRunsToEmit.push(cancelled);

            return true;
          };

          let activeExecutionRun = issue.executionRunId
            ? await tx
                .select()
                .from(heartbeatRuns)
                .where(eq(heartbeatRuns.id, issue.executionRunId))
                .then((rows) => rows[0] ?? null)
            : null;

          if (
            activeExecutionRun &&
            !EXECUTION_PATH_HEARTBEAT_RUN_STATUSES.includes(
              activeExecutionRun.status as (typeof EXECUTION_PATH_HEARTBEAT_RUN_STATUSES)[number],
            )
          ) {
            activeExecutionRun = null;
          }

          if (
            activeExecutionRun &&
            (await cancelStaleScheduledRetry(activeExecutionRun))
          ) {
            activeExecutionRun = null;
          }

          // A queued/scheduled run holding the lock for an agent that is
          // no longer the issue's assignee is stale by design — the issue
          // has been re-routed (e.g. blocked → in_review with a different
          // assignee). Cancel it and release the lock; otherwise the new
          // assignee's wake gets parked in `deferred_issue_execution`
          // forever, because the original queued holder will never run
          // (the issue's status / target now belongs to someone else).
          //
          // Race guard: pin the cancel UPDATE to the exact non-running
          // status we read above. A worker could transition the holder
          // from `queued` → `running` between the SELECT and this UPDATE;
          // the status predicate ensures we never clobber a freshly-
          // claimed running run. If zero rows matched, leave
          // `activeExecutionRun` populated so the defer path runs
          // normally against the now-running holder.
          if (
            activeExecutionRun &&
            activeExecutionRun.status !== "running" &&
            issue.assigneeAgentId &&
            activeExecutionRun.agentId !== issue.assigneeAgentId
          ) {
            const cancelled = await tx
              .update(heartbeatRuns)
              .set({
                status: "cancelled",
                finishedAt: new Date(),
                error:
                  "Execution lock released after issue reassigned to a different agent",
                errorCode: "lock_released_on_reassignment",
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(heartbeatRuns.id, activeExecutionRun.id),
                  eq(heartbeatRuns.status, activeExecutionRun.status),
                ),
              )
              .returning();
            if (cancelled.length > 0) {
              cancelledRunsToEmit.push(cancelled[0]);
              if (activeExecutionRun.wakeupRequestId) {
                await tx
                  .update(agentWakeupRequests)
                  .set({
                    status: "cancelled",
                    finishedAt: new Date(),
                    error:
                      "Execution lock released after issue reassigned to a different agent",
                    updatedAt: new Date(),
                  })
                  .where(
                    eq(
                      agentWakeupRequests.id,
                      activeExecutionRun.wakeupRequestId,
                    ),
                  );
              }
              activeExecutionRun = null;
            }
          }

          if (!activeExecutionRun && issue.executionRunId) {
            await tx
              .update(issues)
              .set({
                executionRunId: null,
                executionAgentNameKey: null,
                executionLockedAt: null,
                updatedAt: new Date(),
              })
              .where(eq(issues.id, issue.id));
          }

          if (!activeExecutionRun) {
            const legacyRun = await tx
              .select()
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.companyId, issue.companyId),
                  inArray(heartbeatRuns.status, [
                    ...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES,
                  ]),
                  sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
                ),
              )
              .orderBy(
                sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
                asc(heartbeatRuns.createdAt),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null);

            if (legacyRun) {
              if (await cancelStaleScheduledRetry(legacyRun)) {
                activeExecutionRun = null;
              } else {
                activeExecutionRun = legacyRun;
                const legacyAgent = await tx
                  .select({ name: agents.name })
                  .from(agents)
                  .where(eq(agents.id, legacyRun.agentId))
                  .then((rows) => rows[0] ?? null);
                await tx
                  .update(issues)
                  .set({
                    executionRunId: legacyRun.id,
                    executionAgentNameKey: normalizeAgentNameKey(
                      legacyAgent?.name,
                    ),
                    executionLockedAt: new Date(),
                    updatedAt: new Date(),
                  })
                  .where(eq(issues.id, issue.id));
              }
            }
          }

          const dependencyReadiness = await issuesSvc
            .listDependencyReadiness(issue.companyId, [issue.id], tx)
            .then((rows) => rows.get(issue.id) ?? null);

          // Blocked descendants should stay idle until the final blocker resolves.
          // Human comment/mention wakes are the exception: they may run in a
          // bounded interaction mode so the assignee can answer or triage.
          const blockedInteractionWake =
            dependencyReadiness &&
            !dependencyReadiness.isDependencyReady &&
            allowsIssueInteractionWake(
              enrichedContextSnapshot,
              ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
            );

          if (blockedInteractionWake) {
            enrichedContextSnapshot.dependencyBlockedInteraction = true;
            enrichedContextSnapshot.unresolvedBlockerIssueIds =
              dependencyReadiness.unresolvedBlockerIssueIds;
            enrichedContextSnapshot.unresolvedBlockerCount =
              dependencyReadiness.unresolvedBlockerCount;
            enrichedContextSnapshot.unresolvedBlockerSummaries =
              await listUnresolvedBlockerSummaries(
                tx,
                issue.companyId,
                issue.id,
                dependencyReadiness.unresolvedBlockerIssueIds,
              );
          }

          if (
            !activeExecutionRun &&
            dependencyReadiness &&
            !dependencyReadiness.isDependencyReady &&
            !blockedInteractionWake
          ) {
            await recordExecutionWait(tx as unknown as Db, {
              issueId: issue.id,
              coalesce: coalesceExecutionWait,
              condition: { unresolvedBlockerIssueIds: [...dependencyReadiness.unresolvedBlockerIssueIds].sort() },
              request: {
                ...durableReceiptFields,
                companyId: agent.companyId,
                agentId,
                source,
                triggerDetail,
                reason: "issue_dependencies_blocked",
                payload: {
                  ...(payload ?? {}),
                  issueId,
                  unresolvedBlockerIssueIds:
                    dependencyReadiness.unresolvedBlockerIssueIds,
                },
                status: "skipped",
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null,
                idempotencyKey: opts.idempotencyKey ?? null,
                finishedAt: new Date(),
              },
            });
            return { kind: "skipped" as const };
          }

          if (
            isolatedWorkspacesEnabled &&
            !activeExecutionRun &&
            issue.status !== "done" &&
            issue.status !== "cancelled"
          ) {
            const issueSettings = parseIssueExecutionWorkspaceSettings(
              issue.executionWorkspaceSettings,
            );
            const resolvedMode = resolveExecutionWorkspaceMode({
              projectPolicy: null,
              issueSettings,
              legacyUseProjectWorkspace: null,
            });
            const workspaceManagedConfig = buildExecutionWorkspaceAdapterConfig(
              {
                agentConfig: parseObject(agent.adapterConfig),
                projectPolicy: null,
                issueSettings,
                mode: resolvedMode,
                legacyUseProjectWorkspace: null,
              },
            );
            const resolvedStrategy = resolveEffectiveWorkspaceStrategyType(
              resolvedMode,
              workspaceManagedConfig,
            );
            const existingExecutionWorkspaceStatus = issue.executionWorkspaceId
              ? await tx
                  .select({ status: executionWorkspaces.status })
                  .from(executionWorkspaces)
                  .where(
                    and(
                      eq(executionWorkspaces.id, issue.executionWorkspaceId),
                      eq(executionWorkspaces.companyId, issue.companyId),
                    ),
                  )
                  .then((rows) => rows[0]?.status ?? null)
              : null;
            const reuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({
              issueExecutionWorkspaceId: issue.executionWorkspaceId,
              issueExecutionWorkspacePreference:
                issue.executionWorkspacePreference,
              existingExecutionWorkspaceStatus,
            });
            const hasResolvablePriorSessionWorkspace =
              await resolveHasResolvablePriorSessionWorkspace();

            if (
              isUnrunnableWorktreeCombo({
                issue: {
                  projectId: issue.projectId ?? projectId ?? null,
                  projectWorkspaceId: issue.projectWorkspaceId,
                  executionWorkspaceId: issue.executionWorkspaceId,
                  executionWorkspacePreference:
                    issue.executionWorkspacePreference,
                },
                resolvedMode,
                resolvedStrategy,
                reusableExecutionWorkspaceAvailable:
                  reuseRequest.existingExecutionWorkspaceAvailable,
                hasResolvablePriorSessionWorkspace,
              })
            ) {
              const now = new Date();
              const issueLabel = formatIssueIdentifierLink(
                issue.identifier,
                issue.id,
              );
              const blockedComment = [
                `Paperclip blocked ${issueLabel} before dispatch because its workspace settings are not runnable.`,
                "",
                `- Code: \`${WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE}\``,
                `- Reason: ${WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE}`,
                `- Next action: ${WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION}`,
              ].join("\n");
              await tx
                .update(issues)
                .set({
                  status: "blocked",
                  checkoutRunId: null,
                  executionRunId: null,
                  executionAgentNameKey: null,
                  executionLockedAt: null,
                  updatedAt: now,
                })
                .where(eq(issues.id, issue.id));
              await tx.insert(issueComments).values({
                companyId: issue.companyId,
                issueId: issue.id,
                body: blockedComment,
                createdAt: now,
                updatedAt: now,
              });
              await tx.insert(agentWakeupRequests).values({
                ...durableReceiptFields,
                companyId: agent.companyId,
                agentId,
                source,
                triggerDetail,
                reason: WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
                payload: {
                  ...(payload ?? {}),
                  issueId,
                  heartbeatSkip: {
                    code: WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
                    reason: WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
                    remediation:
                      WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
                  },
                },
                status: "skipped",
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null,
                idempotencyKey: opts.idempotencyKey ?? null,
                finishedAt: now,
              });
              await logActivity(tx as unknown as Db, {
                companyId: issue.companyId,
                actorType: "system",
                actorId: "system",
                agentId,
                runId: null,
                action: "issue.workspace_preflight_blocked",
                entityType: "issue",
                entityId: issue.id,
                details: {
                  code: WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
                  reason: WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
                  remediation: WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
                  requestedReason: reason,
                  source,
                  triggerDetail,
                  resolvedMode,
                  resolvedStrategy,
                  hasResolvablePriorSessionWorkspace,
                },
              });
              return { kind: "skipped" as const };
            }
          }

          if (activeExecutionRun) {
            // The resolved action is already a durable retry outbox. Do not merge
            // its fresh-session contract into unrelated work or create a second
            // deferred wake that could later replay the same reconciliation.
            if (reconciledSourceRunId) return { kind: "deferred" as const };

            const admissionScope = wakeQueue.createAdmissionTransactionScope(
              agent.companyId,
              tx as unknown as Db,
            );
            const admission = await wakeQueue.admitWakeBehindIssueExecution(
              admissionScope,
              {
                companyId: agent.companyId,
                issueId: issue.id,
                agentId,
                agentNameKey,
                issueExecutionAgentNameKey: issue.executionAgentNameKey,
                activeExecutionRun: {
                  id: activeExecutionRun.id,
                  agentId: activeExecutionRun.agentId,
                  status: activeExecutionRun.status,
                  contextSnapshot: activeExecutionRun.contextSnapshot,
                  wakeupRequestId: activeExecutionRun.wakeupRequestId,
                },
                allowRunCoalescing: isConversation(issue) ? false : opts.allowRunCoalescing,
                durableReceipt: receiptRequest
                  ? {
                      id: receiptRequest.id,
                      requestedAt: receiptRequest.requestedAt,
                    }
                  : undefined,
                reason,
                liveRunExecutions,
                wakeCommentId,
                forceFreshSession:
                  enrichedContextSnapshot.forceFreshSession === true,
                contextSnapshot: enrichedContextSnapshot,
                source,
                triggerDetail,
                payload,
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null,
                idempotencyKey: opts.idempotencyKey ?? null,
              },
            );

            if (admission.kind === "coalesced") {
              return {
                kind: "coalesced" as const,
                run: admission.run as typeof heartbeatRuns.$inferSelect,
              };
            }
            if (admission.kind === "deferred") {
              return { kind: "deferred" as const };
            }
            // admission.kind === "proceed": no active run absorbed this wake,
            // so fall through to the ordinary queue path below.
          }

          // PAP-13775: no live run holds the lock, so this wake would start a
          // fresh adapter session. If this agent's recent runs on this issue
          // keep succeeding without any issue-visible progress and the wake
          // carries no new information, hold it back for an escalating cooldown
          // so external pollers/reconcilers can't storm full-price sessions.
          // Server-side recovery retries insert runs directly and never reach
          // this gate.
          if (
            isThrottleCandidateIssueRewake({
              reason,
              wakeCommentId: wakeCommentId ?? null,
              requestedByActorType: opts.requestedByActorType ?? null,
              forceFreshSession:
                enrichedContextSnapshot.forceFreshSession === true,
              hasExplicitResume: Boolean(explicitResumeSession),
            })
          ) {
            const throttleNow = new Date();
            const recentTerminalRuns = await tx
              .select({
                id: heartbeatRuns.id,
                status: heartbeatRuns.status,
                finishedAt: heartbeatRuns.finishedAt,
              })
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.companyId, agent.companyId),
                  eq(heartbeatRuns.agentId, agentId),
                  sql`${heartbeatRuns.finishedAt} is not null`,
                  gte(
                    heartbeatRuns.finishedAt,
                    new Date(throttleNow.getTime() - ISSUE_REWAKE_LOOKBACK_MS),
                  ),
                  sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
                ),
              )
              .orderBy(desc(heartbeatRuns.finishedAt))
              .limit(ISSUE_REWAKE_RUN_SAMPLE_LIMIT);

            if (recentTerminalRuns.length > 0) {
              const sampleRunIds = recentTerminalRuns.map(
                (sampleRun) => sampleRun.id,
              );
              const progressRows = await tx
                .select({ runId: activityLog.runId })
                .from(activityLog)
                .where(
                  and(
                    eq(activityLog.companyId, agent.companyId),
                    eq(activityLog.entityType, "issue"),
                    eq(activityLog.entityId, issue.id),
                    inArray(activityLog.runId, sampleRunIds),
                    inArray(
                      activityLog.action,
                      ISSUE_PROGRESS_ACTIVITY_ACTIONS,
                    ),
                  ),
                );
              const lastRunFinishedAt =
                recentTerminalRuns[0]?.finishedAt ?? null;
              const newInputRows = lastRunFinishedAt
                ? await tx
                    .select({ id: activityLog.id })
                    .from(activityLog)
                    .where(
                      and(
                        eq(activityLog.companyId, agent.companyId),
                        eq(activityLog.entityType, "issue"),
                        eq(activityLog.entityId, issue.id),
                        gt(activityLog.createdAt, lastRunFinishedAt),
                        inArray(
                          activityLog.action,
                          ISSUE_NEW_INPUT_ACTIVITY_ACTIONS,
                        ),
                        wakeCommentId && opts.requestedByActorType === "agent"
                          ? ne(activityLog.actorType, "agent")
                          : undefined,
                      ),
                    )
                    .limit(1)
                : [];

              const throttleDecision = evaluateIssueRewakeThrottle({
                now: throttleNow,
                recentTerminalRuns,
                runIdsWithIssueProgress: new Set(
                  progressRows
                    .map((row) => row.runId)
                    .filter((runId): runId is string => Boolean(runId)),
                ),
                // For an agent comment wake, the query excludes agent-authored
                // activity while preserving genuinely new user/system input.
                // Presentation/author metadata therefore cannot smuggle human
                // wake privilege, nor can it mask an actual human response.
                hasNewIssueInputSinceLastRun: newInputRows.length > 0,
              });

              if (throttleDecision.blocked) {
                await tx.insert(agentWakeupRequests).values({
                  ...durableReceiptFields,
                  companyId: agent.companyId,
                  agentId,
                  source,
                  triggerDetail,
                  reason: "issue_rewake_throttled",
                  payload: {
                    ...(payload ?? {}),
                    issueId,
                    heartbeatSkip: {
                      reason: "issue_rewake_throttled",
                      requestedReason: reason,
                      noProgressStreak: throttleDecision.noProgressStreak,
                      cooldownMs: throttleDecision.cooldownMs,
                      lastRunFinishedAt:
                        throttleDecision.lastRunFinishedAt.toISOString(),
                      nextAllowedAt:
                        throttleDecision.nextAllowedAt.toISOString(),
                    },
                  },
                  status: "skipped",
                  requestedByActorType: opts.requestedByActorType ?? null,
                  requestedByActorId: opts.requestedByActorId ?? null,
                  idempotencyKey: opts.idempotencyKey ?? null,
                  finishedAt: throttleNow,
                });
                return { kind: "skipped" as const };
              }
            }
          }

          const dailyCapBlock = await getHeartbeatDailyCapBlock(
            agent,
            policy,
            {},
            tx,
          );
          if (dailyCapBlock) {
            if (executionWaitRequestId && executionBlocker) {
              continuationWait = { reason: dailyCapBlock.reason,
                message: "The agent has reached its daily limit. Your message is saved until work can resume." };
              return deferBlockedExecution(executionBlocker);
            }
            const now = new Date();
            await tx.insert(agentWakeupRequests).values({
              ...durableReceiptFields,
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: dailyCapBlock.reason,
              payload: {
                ...(payload ?? {}),
                heartbeatSkip: {
                  reason:
                    "Per-agent heartbeat daily cap reached before adapter invocation.",
                  observed: dailyCapBlock.observed,
                  limit: dailyCapBlock.limit,
                },
              },
              status: "skipped",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              finishedAt: now,
            });
            if (source === "timer") {
              await tx
                .update(agents)
                .set({
                  lastHeartbeatAt: now,
                  updatedAt: now,
                })
                .where(eq(agents.id, agentId));
            }
            return { kind: "skipped" as const };
          }

          const explicitContinuation = await admitExplicitNativeContinuation({
            db: tx as unknown as Db, companyId: issue.companyId, issueId: issue.id,
            agentId, actorType: opts.requestedByActorType, actorId: opts.requestedByActorId,
            reason: durableRequest && !failedChatRetry ? "issue_commented" : reason,
            commentId: wakeCommentId ?? null, failedRunId: opts.failedRunId, successorRunId: explicitContinuationRunId,
            queuedCommentInterruptId: opts.queuedCommentInterruptId,
            queuedCommentRequestId: opts.queuedCommentRequestId,
          });
          if (!explicitContinuation && executionBlocker) return deferBlockedExecution(executionBlocker);
          if (explicitContinuation) {
            enrichedContextSnapshot.forceFreshSession = true;
            enrichedContextSnapshot.previousRunId = explicitContinuation.previousRunId;
            enrichedContextSnapshot.explicitUserContinuation = explicitContinuation;
          }

          const wakeupRequest = await tx
            .insert(agentWakeupRequests)
            .values({
              ...durableReceiptFields,
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason,
              payload,
              status: "queued",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
            })
            .returning()
            .then((rows) => rows[0]);

          // A handoff changes the executor, not the owner of saved user input.
          // Validate its exact stopped source while the issue row is locked;
          // unrelated agents and dedicated continuations keep their own wakes.
          const interruptedRunId = readNonEmptyString(enrichedContextSnapshot.interruptedRunId);
          const handoffSource = source === "assignment" && reason === "issue_assigned" &&
            issue.assigneeAgentId === agentId && interruptedRunId && isUuidLike(interruptedRunId)
              ? await tx.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(
                  eq(heartbeatRuns.id, interruptedRunId), eq(heartbeatRuns.companyId, issue.companyId),
                  eq(heartbeatRuns.status, "cancelled"), eq(heartbeatRuns.errorCode, "issue_reassigned"),
                  ne(heartbeatRuns.agentId, agentId),
                  sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
                  or(isNull(heartbeatRuns.nativeIssueId), eq(heartbeatRuns.nativeIssueId, issue.id)),
                )).then(rows => rows[0] ?? null)
              : null;
          const canCoalesceComments = !isConversation(issue) && opts.allowRunCoalescing !== false;
          // A resumed receipt already passed admission under this issue lock.
          // Consume it with its successor even when chat keeps other messages
          // in separate turns, or finalization will deliver it a second time.
          const pendingComments =
            (executionWaitRequestId || canCoalesceComments) &&
            !(await getExecutionBlocker(tx as unknown as Db, issue.companyId, issue.id))
              ? await tx
                  .select()
                  .from(agentWakeupRequests)
                  .where(
                    and(
                      eq(agentWakeupRequests.companyId, issue.companyId),
                      inArray(agentWakeupRequests.agentId, handoffSource ? [agentId, handoffSource.agentId] : [agentId]),
                      eq(agentWakeupRequests.status, "deferred_issue_execution"),
                      sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
                      canCoalesceComments ? undefined : eq(agentWakeupRequests.id, executionWaitRequestId!),
                    ),
                  )
                  .orderBy(asc(agentWakeupRequests.requestedAt))
              : [];
          const adoptedComments = pendingComments.filter((wake) => {
            if (wake.id === executionWaitRequestId) return true;
            if (wake.id === opts.queuedCommentInterruptId || wake.id === opts.queuedCommentRequestId) return true;
            const deferredPayload = parseObject(wake.payload);
            const deferredContext = parseObject(
              deferredPayload[DEFERRED_WAKE_CONTEXT_KEY],
            );
            // Dedicated interaction wakes carry their own source and session
            // contract. ID-only adoption must not erase that continuation.
            return (
              // Durable chat work must keep its receipt, actor, source, and
              // session contract through normal promotion and authorization.
              !wake.idempotencyKey?.startsWith("chat-inbound:") &&
              !isInteractionResolutionWakePayload(deferredPayload) &&
              !hasInteractionContinuationWakeContext(deferredContext) &&
              ["issue_commented", "issue_reopened_via_comment"].includes(String(deferredContext.wakeReason ?? wake.reason)) &&
              queuedCommentIdsFromWakePayload(wake.payload).length > 0
            );
          });
          let adoptedCommentIds = [
            ...new Set([
              ...adoptedComments.flatMap((wake) =>
                queuedCommentIdsFromWakePayload(wake.payload),
              ),
              ...queuedCommentIdsFromRunContext(enrichedContextSnapshot),
            ]),
          ];
          if (opts.queuedCommentRequestId || handoffSource) {
            adoptedCommentIds = await undeliveredLegacyUserCommentIds(tx as unknown as Db,
              agent.companyId, issueId, agentId, adoptedCommentIds);
          }
          const newRun = await tx
            .insert(heartbeatRuns)
            .values({
              ...(explicitContinuation ? { id: explicitContinuationRunId } : {}),
              companyId: agent.companyId,
              agentId,
            scopeKind: readNonEmptyString(enrichedContextSnapshot.issueId) ? "issue" : "company",
            issueId: readNonEmptyString(enrichedContextSnapshot.issueId),
              invocationSource: source,
              triggerDetail,
              status: "queued",
              responsibleUserId: await resolveQueuedResponsibleUserId(),
              wakeupRequestId: wakeupRequest.id,
              retryOfRunId: failedChatRetry
                ? durableRequest!.failedRunRetry!.failedRunId
                : opts.failedRunId ?? automaticParentRunId,
              contextSnapshot: adoptedComments.length
                ? withQueuedCommentIdsInRunContext(
                    enrichedContextSnapshot,
                    adoptedCommentIds,
                  )
                : enrichedContextSnapshot,
              sessionIdBefore: explicitContinuation ? null : sessionBefore,
              continuationAttempt,
              ...(reconciledSourceRunId
                ? { retryOfRunId: reconciledSourceRunId }
                : {}),
              ...(reconciledRestoreRetryCount !== null ? {
                scheduledRetryAttempt: reconciledRestoreRetryCount,
                scheduledRetryReason: "transient_failure",
              } : {}),
            })
            .returning()
            .then((rows) => rows[0]);

          await tx
            .update(agentWakeupRequests)
            .set({
              runId: newRun.id,
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, wakeupRequest.id));

          if (adoptedComments.length) {
            await tx
              .update(agentWakeupRequests)
              .set({
                status: "coalesced",
                runId: newRun.id,
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(
                inArray(
                  agentWakeupRequests.id,
                  adoptedComments.map((wake) => wake.id),
                ),
              );
            await tx
              .update(agentWakeupRequests)
              .set({
                payload: withQueuedCommentIdsInWakePayload(payload, adoptedCommentIds),
              })
              .where(eq(agentWakeupRequests.id, wakeupRequest.id));
          }

          // executionRunId is NOT stamped here (enqueueWakeup queues the run but
          // doesn't start it). It will be stamped in claimQueuedRun() once the run
          // transitions to "running" — Fix A (lazy locking).

          return { kind: "queued" as const, run: newRun };
        })
        .catch((error) => {
          if (isExternalChatWaitAuthorizationContention(error))
            return { kind: "deferred" as const };
          throw error;
        });

      // Telemetry for the cancelled runs is best-effort background work.
      // Fire it here and never await it: none of the lifecycle work below,
      // nor this function's return, depends on it, so a slow telemetry
      // lookup must not delay them.
      for (const cancelledRun of cancelledRunsToEmit) {
        void emitAgentTaskRun(db, cancelledRun);
      }

      if (outcome.kind === "durable") {
        return outcome.receipt.runId ? getRun(outcome.receipt.runId) : null;
      }
      if (outcome.kind === "deferred" || outcome.kind === "skipped") {
        return null;
      }
      if (outcome.kind === "coalesced") {
        await startNextQueuedRunForAgent(agent.id);
        return outcome.run;
      }
      if (outcome.kind === "replayed") {
        if (outcome.run.status === "queued")
          await startNextQueuedRunForAgent(agent.id);
        return outcome.run;
      }

      const newRun = outcome.run;
      publishLiveEvent({
        companyId: newRun.companyId,
        type: "heartbeat.run.queued",
        payload: {
          runId: newRun.id,
          agentId: newRun.agentId,
          invocationSource: newRun.invocationSource,
          triggerDetail: newRun.triggerDetail,
          wakeupRequestId: newRun.wakeupRequestId,
        },
      });

      await startNextQueuedRunForAgent(agent.id);
      return newRun;
    }

    if (durableRequest) throw new Error("chat_inbound_wakeup_binding_denied");

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          inArray(heartbeatRuns.status, [
            ...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES,
          ]),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    const sameScopeQueuedRun = activeRuns.find(
      (candidate) =>
        candidate.status === "queued" &&
        isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeScheduledRetryRun = activeRuns.find(
      (candidate) =>
        candidate.status === "scheduled_retry" &&
        isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeRunningRun = activeRuns.find(
      (candidate) =>
        candidate.status === "running" &&
        isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const shouldQueueFollowupForRunningWake =
      Boolean(sameScopeRunningRun) &&
      !sameScopeQueuedRun &&
      shouldQueueFollowupForRunningIssueWake({
        contextSnapshot: enrichedContextSnapshot,
        wakeCommentId,
      });
    // Unscoped manual wakes need their own receipt and execution identity too.
    const rawCoalescedTarget =
      opts.allowRunCoalescing === false || opts.manualUserWake
        ? null
        : (sameScopeQueuedRun ??
          sameScopeScheduledRetryRun ??
          (shouldQueueFollowupForRunningWake
            ? null
            : (sameScopeRunningRun ?? null)));

    const coalescedTargetRun = filterZombieCoalesceTarget(
      rawCoalescedTarget,
      liveRunExecutions,
    );

    if (coalescedTargetRun) {
      const mergedContextSnapshot = mergeCoalescedContextSnapshot(
        coalescedTargetRun.contextSnapshot,
        enrichedContextSnapshot,
        {
          preserveExistingInteractionContinuation:
            coalescedTargetRun.status === "queued" ||
            coalescedTargetRun.status === "scheduled_retry",
        },
      );
      const mergedRun = await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: mergedContextSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, coalescedTargetRun.id))
        .returning()
        .then((rows) => rows[0] ?? coalescedTargetRun);

      await db.insert(agentWakeupRequests).values({
        ...durableReceiptFields,
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "coalesced",
        coalescedCount: 1,
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        runId: mergedRun.id,
        finishedAt: new Date(),
      });
      return mergedRun;
    }

    const queueOutcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from agents where id = ${agentId} and company_id = ${agent.companyId} for update`,
      );

      const dailyCapBlock = await getHeartbeatDailyCapBlock(
        agent,
        policy,
        {},
        tx,
      );
      if (dailyCapBlock) {
        const now = new Date();
        await tx.insert(agentWakeupRequests).values({
          ...durableReceiptFields,
          companyId: agent.companyId,
          agentId,
          source,
          triggerDetail,
          reason: dailyCapBlock.reason,
          payload: {
            ...(payload ?? {}),
            heartbeatSkip: {
              reason:
                "Per-agent heartbeat daily cap reached before adapter invocation.",
              observed: dailyCapBlock.observed,
              limit: dailyCapBlock.limit,
            },
          },
          status: "skipped",
          requestedByActorType: opts.requestedByActorType ?? null,
          requestedByActorId: opts.requestedByActorId ?? null,
          idempotencyKey: opts.idempotencyKey ?? null,
          finishedAt: now,
        });
        if (source === "timer") {
          await tx
            .update(agents)
            .set({
              lastHeartbeatAt: now,
              updatedAt: now,
            })
            .where(eq(agents.id, agentId));
        }
        return { kind: "skipped" as const };
      }

      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          ...durableReceiptFields,
          companyId: agent.companyId,
          agentId,
          source,
          triggerDetail,
          reason,
          payload,
          status: "queued",
          requestedByActorType: opts.requestedByActorType ?? null,
          requestedByActorId: opts.requestedByActorId ?? null,
          idempotencyKey: opts.idempotencyKey ?? null,
        })
        .returning()
        .then((rows) => rows[0]);

      const newRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: agent.companyId,
          agentId,
          scopeKind: readNonEmptyString(enrichedContextSnapshot.issueId) ? "issue" : "company",
          issueId: readNonEmptyString(enrichedContextSnapshot.issueId),
          invocationSource: source,
          triggerDetail,
          status: "queued",
          responsibleUserId: await resolveQueuedResponsibleUserId(),
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: enrichedContextSnapshot,
          sessionIdBefore: sessionBefore,
          continuationAttempt,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({
          runId: newRun.id,
          updatedAt: new Date(),
        })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

      return { kind: "queued" as const, run: newRun };
    });

    if (queueOutcome.kind === "skipped") return null;
    const newRun = queueOutcome.run;

    publishLiveEvent({
      companyId: newRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: newRun.id,
        agentId: newRun.agentId,
        invocationSource: newRun.invocationSource,
        triggerDetail: newRun.triggerDetail,
        wakeupRequestId: newRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(agent.id);

    return newRun;
  }

  /**
   * Native status commitment deliberately persists dependency/parent wake
   * intents in the same transaction as the authoritative status projection.
   * Those rows are not runnable until the heartbeat scheduler has applied its
   * normal policy, workspace, concurrency, and responsible-user checks. Bridge
   * the durable intent into that scheduler here instead of treating a bare
   * `agent_wakeup_requests` row as if it were already a queued heartbeat run.
   *
   * The intent is claimed before dispatch. A deterministic dispatcher actor id
   * lets a later sweep recover the narrow process-crash window after the real
   * wake was inserted but before the intent was linked to it. Dispatch failure
   * only requeues the intent; it never changes the provider run outcome.
   */
  async function dispatchPendingNativeStatusWakeups(
    input: {
      companyId?: string;
      limit?: number;
      staleClaimMs?: number;
    } = {},
  ) {
    const now = new Date();
    const staleClaimMs = Math.max(1_000, input.staleClaimMs ?? 60_000);
    const candidates = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          input.companyId
            ? eq(agentWakeupRequests.companyId, input.companyId)
            : undefined,
          eq(agentWakeupRequests.requestedByActorType, "system"),
          eq(agentWakeupRequests.requestedByActorId, "native-status-committer"),
          inArray(agentWakeupRequests.status, ["queued", "claimed"]),
          isNull(agentWakeupRequests.runId),
        ),
      )
      .orderBy(asc(agentWakeupRequests.requestedAt))
      .limit(Math.max(1, Math.min(input.limit ?? 100, 500)));

    let dispatched = 0;
    let recovered = 0;
    let deferred = 0;
    const deliveredByIssueScope = new Map<
      string,
      { runId: string | null; status: string }
    >();

    for (const candidate of candidates) {
      const dispatchActorId = `native-status-wake-dispatch:${candidate.id}`;
      const existingDispatch = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, candidate.companyId),
            eq(agentWakeupRequests.requestedByActorType, "system"),
            eq(agentWakeupRequests.requestedByActorId, dispatchActorId),
          ),
        )
        .orderBy(desc(agentWakeupRequests.requestedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (existingDispatch) {
        const recoveredStatus = existingDispatch.runId
          ? "coalesced"
          : existingDispatch.status === "deferred_issue_execution"
            ? "coalesced"
            : existingDispatch.status;
        await db
          .update(agentWakeupRequests)
          .set({
            status: recoveredStatus,
            runId: existingDispatch.runId,
            finishedAt:
              (existingDispatch.runId ?? existingDispatch.finishedAt)
                ? (existingDispatch.finishedAt ?? now)
                : null,
            error: existingDispatch.error,
            updatedAt: now,
          })
          .where(
            and(
              eq(agentWakeupRequests.id, candidate.id),
              isNull(agentWakeupRequests.runId),
            ),
          );
        recovered += 1;
        continue;
      }

      if (
        candidate.status === "claimed" &&
        candidate.claimedAt &&
        now.getTime() - candidate.claimedAt.getTime() < staleClaimMs
      ) {
        deferred += 1;
        continue;
      }

      const claimed = await db
        .update(agentWakeupRequests)
        .set({
          status: "claimed",
          claimedAt: now,
          error: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentWakeupRequests.id, candidate.id),
            isNull(agentWakeupRequests.runId),
            candidate.status === "claimed"
              ? eq(agentWakeupRequests.status, "claimed")
              : eq(agentWakeupRequests.status, "queued"),
          ),
        )
        .returning({ id: agentWakeupRequests.id });
      if (claimed.length === 0) continue;

      const payload = parseObject(candidate.payload);
      const wakeContext = parseObject(payload._paperclipWakeContext);
      const issueId =
        readNonEmptyString(payload.issueId) ??
        readNonEmptyString(payload.taskId) ??
        readNonEmptyString(wakeContext.issueId) ??
        null;
      const scopeKey = issueId
        ? `${candidate.companyId}:${candidate.agentId}:${issueId}:${readNativeReviewAssignmentContext(wakeContext)?.nativeReviewInteractionId ?? ""}`
        : null;
      const priorDelivery = scopeKey
        ? deliveredByIssueScope.get(scopeKey)
        : null;
      if (priorDelivery) {
        await db
          .update(agentWakeupRequests)
          .set({
            status: "coalesced",
            runId: priorDelivery.runId,
            finishedAt: new Date(),
            error: null,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, candidate.id));
        recovered += 1;
        continue;
      }

      let completedOnboardingGuard: WakeupOptions["issueStateGuard"];
      if (issueId) {
        const targetIssue = await db
          .select({
            status: issues.status,
            statusVersion: issues.statusVersion,
            assigneeAgentId: issues.assigneeAgentId,
          })
          .from(issues)
          .where(
            and(
              eq(issues.id, issueId),
              eq(issues.companyId, candidate.companyId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const nativeReview = candidate.reason === "native_completion_review"
          ? await getNativeReviewAssignment(db, {
              companyId: candidate.companyId, issueId, agentId: candidate.agentId,
              contextSnapshot: wakeContext,
            })
          : null;
        const onboardingResultReport = targetIssue?.status === "done" && await isCompletedOnboardingHandoffWake(db, {
          companyId: candidate.companyId, issueId, agentId: candidate.agentId,
          reason: candidate.reason, contextSnapshot: wakeContext,
        });
        if (onboardingResultReport) completedOnboardingGuard = { assigneeAgentId: candidate.agentId, statuses: ["done"], statusVersion: targetIssue!.statusVersion };
        if (
          !targetIssue ||
          (["done", "cancelled"].includes(targetIssue.status) && !onboardingResultReport) ||
          (targetIssue.assigneeAgentId !== candidate.agentId && !nativeReview) ||
          (candidate.reason === "native_completion_review" && !nativeReview)
        ) {
          await db
            .update(agentWakeupRequests)
            .set({
              status: "skipped",
              finishedAt: new Date(),
              error: !targetIssue
                ? "Native status wake target no longer exists"
                : ["done", "cancelled"].includes(targetIssue.status)
                  ? `Native status wake target is already ${targetIssue.status}`
                  : "Native status wake target has a different assignee",
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, candidate.id));
          recovered += 1;
          continue;
        }
      }

      try {
        const wakeRun = await enqueueWakeup(candidate.agentId, {
          source: candidate.source as WakeupOptions["source"],
          triggerDetail: (candidate.triggerDetail ??
            "system") as WakeupOptions["triggerDetail"],
          reason: candidate.reason,
          payload,
          idempotencyKey: candidate.idempotencyKey,
          requestedByActorType: "system",
          requestedByActorId: dispatchActorId,
          ...(completedOnboardingGuard ? { issueStateGuard: completedOnboardingGuard } : {}),
          contextSnapshot: {
            ...wakeContext,
            ...(issueId ? { issueId, taskId: issueId } : {}),
            wakeReason: candidate.reason,
            source: "native_status_decision",
            statusDecisionSource: "native_status_decision",
            nativeStatusWakeIntentId: candidate.id,
          },
        });

        const delivered = await db
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, candidate.companyId),
              eq(agentWakeupRequests.requestedByActorType, "system"),
              eq(agentWakeupRequests.requestedByActorId, dispatchActorId),
            ),
          )
          .orderBy(desc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        // The committer intent is the durable outbox entry. When admission is
        // blocked, enqueueWakeup creates a separate deferred dispatch receipt;
        // leave the original intent coalesced so the release drain cannot
        // promote both rows (the original has no nativeStatusWakeIntentId
        // provenance and would otherwise run once before the dispatch receipt).
        const deliveredStatus = delivered?.status ?? "queued";
        await db
          .update(agentWakeupRequests)
          .set({
            status: wakeRun || deliveredStatus === "deferred_issue_execution"
              ? "coalesced"
              : deliveredStatus,
            runId: wakeRun?.id ?? delivered?.runId ?? null,
            finishedAt:
              wakeRun || delivered?.finishedAt
                ? (delivered?.finishedAt ?? new Date())
                : null,
            error: delivered?.error ?? null,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, candidate.id));

        if (scopeKey) {
          deliveredByIssueScope.set(scopeKey, {
            runId: wakeRun?.id ?? delivered?.runId ?? null,
            status: wakeRun ? "coalesced" : (delivered?.status ?? "queued"),
          });
        }

        if (wakeRun) dispatched += 1;
        else deferred += 1;
      } catch (error) {
        await db
          .update(agentWakeupRequests)
          .set({
            status: "queued",
            claimedAt: null,
            error:
              error instanceof Error
                ? error.message.slice(0, 1_000)
                : String(error).slice(0, 1_000),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agentWakeupRequests.id, candidate.id),
              eq(agentWakeupRequests.status, "claimed"),
              isNull(agentWakeupRequests.runId),
            ),
          );
        logger.warn(
          {
            err: error,
            wakeupRequestId: candidate.id,
            agentId: candidate.agentId,
          },
          "failed to dispatch persisted native status wake intent",
        );
        deferred += 1;
      }
    }

    return { scanned: candidates.length, dispatched, recovered, deferred };
  }

  async function listProjectScopedRunIds(companyId: string, projectId: string, createdBefore?: Date) {
    const runIssueId = sql<
      string | null
    >`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const effectiveProjectId = sql<
      string | null
    >`coalesce(${heartbeatRuns.contextSnapshot} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([heartbeatRuns.id], { id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${runIssueId}`,
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          createdBefore ? lt(heartbeatRuns.createdAt, createdBefore) : undefined,
          inArray(heartbeatRuns.status, [
            ...CANCELLABLE_HEARTBEAT_RUN_STATUSES,
          ]),
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function listProjectScopedWakeupIds(
    companyId: string,
    projectId: string,
    database: Db = db,
  ) {
    const wakeIssueId = sql<
      string | null
    >`${agentWakeupRequests.payload} ->> 'issueId'`;
    const effectiveProjectId = sql<
      string | null
    >`coalesce(${agentWakeupRequests.payload} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await database
      .selectDistinctOn([agentWakeupRequests.id], {
        id: agentWakeupRequests.id,
      })
      .from(agentWakeupRequests)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${wakeIssueId}`,
        ),
      )
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, [
            "queued",
            "deferred_issue_execution",
          ]),
          sql`${agentWakeupRequests.runId} is null`,
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function cancelPendingWakeupsForBudgetScope(
    scope: BudgetEnforcementScope,
  ) {
    return withCurrentBudgetEnforcement(db, scope, async (tx) => {
      const now = new Date();
      let wakeupIds: string[] = [];

      if (scope.scopeType === "company") {
        wakeupIds = await tx
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, scope.companyId),
              inArray(agentWakeupRequests.status, [
                "queued",
                "deferred_issue_execution",
              ]),
              sql`${agentWakeupRequests.runId} is null`,
            ),
          )
          .then((rows) => rows.map((row) => row.id));
      } else if (scope.scopeType === "agent") {
        wakeupIds = await tx
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, scope.companyId),
              eq(agentWakeupRequests.agentId, scope.scopeId),
              inArray(agentWakeupRequests.status, [
                "queued",
                "deferred_issue_execution",
              ]),
              sql`${agentWakeupRequests.runId} is null`,
            ),
          )
          .then((rows) => rows.map((row) => row.id));
      } else {
        wakeupIds = await listProjectScopedWakeupIds(
          scope.companyId,
          scope.scopeId,
          tx,
        );
      }

      if (wakeupIds.length === 0) return 0;

      await tx
        .update(agentWakeupRequests)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: "Cancelled due to budget pause",
          updatedAt: now,
        })
        .where(and(
          inArray(agentWakeupRequests.id, wakeupIds),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          isNull(agentWakeupRequests.runId),
          scope.createdBefore ? lt(agentWakeupRequests.createdAt, scope.createdBefore) : undefined,
        ));

      return wakeupIds.length;
    });
  }

  type CancelRunOptions = {
    budgetEnforcement?: BudgetEnforcementScope;
    /** Optional board request identity, atomically reserved for native Stop. */
    cancellationRequestId?: string;
    cancellationRequestedByUserId?: string | null;
    errorCode?: string;
    resultJson?: Record<string, unknown>;
    eventMessage?: string;
    eventPayload?: Record<string, unknown>;
    /** Per-call graceful process shutdown window, bounded to a safe range. */
    terminationGraceMs?: number;
    /** Caller is immediately scheduling an explicit successor path. */
    suppressImmediateRecovery?: boolean;
  };

  function cancellationTerminationGraceMs(
    configuredGraceSec: number,
    requestedGraceMs: number | undefined,
  ) {
    const configuredGraceMs = Math.max(1, configuredGraceSec) * 1000;
    if (requestedGraceMs === undefined || !Number.isFinite(requestedGraceMs)) {
      return configuredGraceMs;
    }
    return Math.max(100, Math.min(30_000, Math.trunc(requestedGraceMs)));
  }

  async function cancelRunInternal(
    runId: string,
    reason = "Cancelled by control plane",
    options: CancelRunOptions = {},
  ) {
    let run = await getRun(runId);
    if (!run) throw notFound("Heartbeat run not found");
    if (options.cancellationRequestId) {
      run = await claimCancellationRequest(db, runId, run.companyId, options.cancellationRequestId, options.cancellationRequestedByUserId ?? null);
    }
    // The caller claim checked retry eligibility under both durable row locks.
    // This is only a cancellation candidate: dispatch rechecks the coordinator
    // under lock, and the final CAS requires its own unchanged acknowledged
    // retry fence. Re-reading only retryable_failure here would strand replay.
    const pendingNativeRetry =
      run.runtimeMode === "native" && run.status === "failed" && (
        Boolean(options.cancellationRequestId) || await db
          .select({ runId: nativeRunFinalizations.runId })
          .from(nativeRunFinalizations)
          .where(
            and(
              eq(nativeRunFinalizations.runId, run.id),
              eq(nativeRunFinalizations.companyId, run.companyId),
              eq(nativeRunFinalizations.phase, "retryable_failure"),
            ),
          )
          .then((rows) => rows.length > 0)
      );
    if (
      !pendingNativeRetry &&
      !CANCELLABLE_HEARTBEAT_RUN_STATUSES.includes(
        run.status as (typeof CANCELLABLE_HEARTBEAT_RUN_STATUSES)[number],
      )
    )
      return run;
    const agent = await getAgent(run.agentId);
    const errorCode = options.errorCode ?? "cancelled";
    const cancellation = requestedRunCancellation(options.resultJson ?? {}, reason);

    const pendingProcessCancellation = processRunCancellationSettlements.get(
      run.id,
    );
    if (pendingProcessCancellation) {
      await pendingProcessCancellation.settled;
      if (pendingProcessCancellation.failed)
        throw pendingProcessCancellation.error;
      return getRun(run.id);
    }
    const running = runningProcesses.get(run.id);
    const stopOwnership =
      run.runtimeMode !== "native"
        ? captureAdapterStopOwnership(run.id)
        : undefined;
    const control = stopOwnership?.control;
    // Capture the existing adapter owner before waiting on the run lock. Then
    // atomically fence preparation and refresh the selected runtime, so Stop
    // cannot miss a native handoff that won after its first read.
    // Established legacy processes must still be stopped if the database is
    // unavailable. Only native or not-yet-dispatched preparation needs this
    // additional durable fence before its existing cancellation path.
    if (options.budgetEnforcement || (!options.cancellationRequestId && (run.runtimeMode === "native" || (!run.runtimeModeResolvedAt && !running && !control)))) {
      const fence = async (tx: Db) => {
        const [fenced] = await tx.update(heartbeatRuns).set({
          // Record handoff intent before native cancellation can finalize and release
          // the run. Only its audited stop acknowledgement suppresses recovery.
          resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
            ${JSON.stringify(options.errorCode === "issue_reassigned" && options.resultJson?.reassignmentStopConfirmed === true
              ? { reassignmentStopRequested: true } : {})}::jsonb ||
            ${JSON.stringify({ cancellation })}::jsonb ||
            jsonb_build_object('startupCancellation', jsonb_build_object(
              'requestedAt', ${new Date().toISOString()}::text,
              'beforeNativeSelection', ${heartbeatRuns.runtimeMode} = 'legacy'
                and ${heartbeatRuns.runtimeModeResolvedAt} is null
                and ${heartbeatRuns.executionStage} = 'preparing'
                and coalesce(${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType' = 'paperclip_runner', false)
            ))`,
        }).where(and(eq(heartbeatRuns.id, runId), inArray(heartbeatRuns.status,
          pendingNativeRetry ? [...CANCELLABLE_HEARTBEAT_RUN_STATUSES, "failed"] : [...CANCELLABLE_HEARTBEAT_RUN_STATUSES],
        ))).returning();
        return fenced ?? null;
      };
      let fenced: typeof run | null;
      try {
        fenced = options.budgetEnforcement
          ? await withCurrentBudgetEnforcement(db, options.budgetEnforcement, fence)
          : await fence(db);
      } catch (error) {
        stopOwnership?.release();
        throw error;
      }
      if (!fenced) {
        stopOwnership?.release();
        return getRun(runId);
      }
      run = fenced;
    }
    const resultJson = { ...(agent
      ? {
          ...mergeRunStopMetadataForAgent(agent, "cancelled", {
            resultJson: parseObject(run.resultJson),
            errorCode,
            errorMessage: reason,
          }),
          ...(options.resultJson ?? {}),
        }
      : options.resultJson), cancellation };

    try {
      let releaseProcessCancellation: (() => void) | undefined;
      const processCancellationSettlement =
        run.runtimeMode !== "native" &&
        !control &&
        running
          ? {
              settled: new Promise<void>((resolve) => {
                releaseProcessCancellation = resolve;
              }),
              failed: false,
              error: undefined as unknown,
            }
          : undefined;
      if (processCancellationSettlement) {
        // No await between joining an existing owner above and registering ours.
        processRunCancellationSettlements.set(
          run.id,
          processCancellationSettlement,
        );
      }
      const cancellation = await (async () => {
        try {
          if (control) {
            await db
              .update(heartbeatRuns)
              .set({
                error: reason,
                errorCode,
                // Stop may have read the row before adapter settlement saved
                // a required-copyback receipt. Merge into current database JSON
                // and leave those server-owned fields to the restore recorder.
                resultJson: preserveWorkspaceRestoreRecoveryMetadataSql({
                  ...resultJson,
                  ...(!running ? { executionCancellation: {
                    state: "requested", requestedAt: new Date().toISOString(),
                  } } : {}),
                }, true),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(heartbeatRuns.id, run.id),
                  eq(heartbeatRuns.status, "running"),
                ),
              );
            control.controller.abort(new Error(reason));
          }
          let terminationSettled = false;
          try {
            await cancelHeartbeatNativeRun({
              db,
              runId: run.id,
              reason,
              runtimeMode: run.runtimeMode,
              ...(options.cancellationRequestId ? { cancellationRequestId: options.cancellationRequestId } : {}),
            });
            if (running) {
              await terminateHeartbeatRunProcess({
                pid: running.child.pid,
                processGroupId: running.processGroupId,
                // Codex handles Ctrl-C by cancelling its tool sessions. SIGTERM
                // can leave commands in their separate process groups alive.
                signal: !control && agent?.adapterType === "codex_local" ? "SIGINT" : undefined,
                graceMs: cancellationTerminationGraceMs(
                  running.graceSec,
                  options.terminationGraceMs,
                ),
              });
            }
            terminationSettled = true;
          } finally {
            if (
              (!processCancellationSettlement || terminationSettled) &&
              runningProcesses.get(run.id) === running
            ) {
              runningProcesses.delete(run.id);
            }
          }

          if (control) {
            await waitForAdapterStop(control.settled, undefined, {
              runId: run.id,
              adapterType: agent?.adapterType,
              runtimeMode: run.runtimeMode,
              abortRequested: control.controller.signal.aborted,
            }, control);
            const stopped = await getRun(run.id);
            if (stopped && isHeartbeatRunTerminalStatus(stopped.status)) {
              if (
                parseObject(stopped.resultJson?.executionCancellation).state !==
                "acknowledged"
              ) {
                throw conflict(
                  "Execution ended, but provider termination could not be verified. Inspect the stopped run before continuing.",
                );
              }
              // The owned adapter already finalized this run and its lifecycle.
              // Do not replay the process cancellation side effects below.
              return { run: stopped, updated: false };
            }
          }

          const finishedAt = new Date();
          const persistedCancellationResult =
            run.runtimeMode === "native"
              ? await getRun(run.id).then((current) =>
                  parseObject(current?.resultJson),
                )
              : {};
          return await setRunStatusFromLive(
            run.id,
            "cancelled",
            pendingNativeRetry
              ? [...CANCELLABLE_HEARTBEAT_RUN_STATUSES, "failed"]
              : [...CANCELLABLE_HEARTBEAT_RUN_STATUSES],
            {
              finishedAt,
              error: reason,
              errorCode,
              ...(resultJson ||
              Object.keys(persistedCancellationResult).length > 0
                ? {
                    resultJson: {
                      ...persistedCancellationResult,
                      ...(resultJson ?? {}),
                      // A scheduler placeholder has no process to acknowledge.
                      // Preserve its normal release policy instead of treating
                      // it as an operator stop of provider work.
                      ...(processCancellationSettlement && agent && running && (
                        (Number.isInteger(running.child.pid) && (running.child.pid ?? 0) > 0) ||
                        (Number.isInteger(running.processGroupId) && (running.processGroupId ?? 0) > 0)
                      )
                        ? mergeRunStopMetadataForAgent(agent, "cancelled", {
                            resultJson: {
                              ...resultJson,
                              executionCancellation: { state: "acknowledged", acknowledgedAt: finishedAt.toISOString() },
                            },
                            errorCode, errorMessage: reason,
                          })
                        : {}),
                      // The native cancellation helper may have advanced a durable
                      // pending intent to its acknowledged state after `run` was
                      // first read. Never let that stale snapshot overwrite the
                      // authoritative post-dispatch acknowledgement.
                      ...(Object.hasOwn(
                        persistedCancellationResult,
                        "nativeCancellation",
                      )
                        ? {
                            nativeCancellation:
                              persistedCancellationResult.nativeCancellation,
                          }
                        : {}),
                    },
                  }
                : {}),
            },
            undefined,
            pendingNativeRetry ? nativeRetryCancellationCommitCondition(persistedCancellationResult) : undefined,
          );
        } catch (error) {
          if (processCancellationSettlement) {
            processCancellationSettlement.failed = true;
            processCancellationSettlement.error = error;
            if (activeRunExecutions.has(run.id)) {
              failedProcessRunCancellations.set(
                run.id,
                processCancellationSettlement,
              );
            }
          }
          throw error;
        } finally {
          if (processCancellationSettlement) {
            if (
              processRunCancellationSettlements.get(run.id) ===
              processCancellationSettlement
            ) {
              processRunCancellationSettlements.delete(run.id);
            }
            // Always settle waiters, including termination and DB errors. A
            // failed Stop remains an error to its caller, never a cancellation
            // receipt; the signal-bearing executor may then record failure.
            releaseProcessCancellation?.();
          }
        }
      })();
      const cancelled = cancellation.run;

      if (cancellation.updated && cancelled) {
        await setWakeupStatus(run.wakeupRequestId, "cancelled", {
          finishedAt: cancelled.finishedAt ?? new Date(),
          error: reason,
        });
        await appendRunEvent(cancelled, {
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: options.eventMessage ?? "run cancelled",
          payload: { ...options.eventPayload, cancellation: readRunCancellation(cancelled.resultJson) },
        });
        await releaseIssueExecutionAndPromote(cancelled, {
          suppressImmediateRecovery: options.suppressImmediateRecovery,
        });
        await finalizeAgentStatus(run.agentId, "cancelled", undefined, {
          wasFirstHeartbeat: timerClaimWasFirstHeartbeat(run),
        });
        await startNextQueuedRunForAgent(run.agentId);
      }
      return cancelled;
    } finally {
      stopOwnership?.release();
    }
  }

  async function cancelActiveForAgentInternal(
    agentId: string,
    reason = "Cancelled due to agent pause",
    errorCode = "cancelled",
  ) {
    const agent = await getAgent(agentId);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          inArray(heartbeatRuns.status, [...CANCELLABLE_HEARTBEAT_RUN_STATUSES]),
        ),
      );

    for (const run of runs) {
      const stopOwnership =
        run.runtimeMode !== "native"
          ? captureAdapterStopOwnership(run.id)
          : undefined;
      try {
        if (stopOwnership?.control) {
          await cancelRunInternal(run.id, reason, { errorCode });
          continue;
        }
        if (run.runtimeMode === "native") {
          await db.update(heartbeatRuns).set({ resultJson:
            sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ cancellation: requestedRunCancellation({}, reason) })}::jsonb`,
          }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, run.status)));
          await cancelHeartbeatNativeRun({
            db,
            runId: run.id,
            reason,
            runtimeMode: run.runtimeMode,
          });
        }
        const persistedCancellationResult =
          run.runtimeMode === "native"
            ? await getRun(run.id).then((current) =>
                parseObject(current?.resultJson),
              )
            : parseObject(run.resultJson);
        await setRunStatus(run.id, "cancelled", {
          finishedAt: new Date(),
          error: reason,
          errorCode,
          resultJson: {
            ...persistedCancellationResult,
            ...(agent ? mergeRunStopMetadataForAgent(agent, "cancelled", {
              resultJson: persistedCancellationResult, errorCode, errorMessage: reason,
            }) : {}),
            cancellation: readRunCancellation(persistedCancellationResult) ?? requestedRunCancellation({}, reason),
          },
        });

        await setWakeupStatus(run.wakeupRequestId, "cancelled", {
          finishedAt: new Date(),
          error: reason,
        });

        const running = runningProcesses.get(run.id);
        if (running) {
          await terminateHeartbeatRunProcess({
            pid: running.child.pid,
            processGroupId: running.processGroupId,
            graceMs: Math.max(1, running.graceSec) * 1000,
          });
        }
        runningProcesses.delete(run.id);
        await releaseIssueExecutionAndPromote(run);
      } finally {
        stopOwnership?.release();
      }
    }

    return runs.length;
  }

  async function cancelPendingWakeupsForAgentsInternal(
    agentIds: string[],
    reason: string,
  ) {
    const uniqueAgentIds = [...new Set(agentIds)].filter(
      (agentId) => agentId.length > 0,
    );
    if (uniqueAgentIds.length === 0) return 0;

    const now = new Date();
    const wakeupIds = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          inArray(agentWakeupRequests.agentId, uniqueAgentIds),
          inArray(agentWakeupRequests.status, [
            "queued",
            "deferred_issue_execution",
          ]),
          sql`${agentWakeupRequests.runId} is null`,
        ),
      )
      .then((rows) => rows.map((row) => row.id));

    if (wakeupIds.length === 0) return 0;

    await db
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: reason,
        updatedAt: now,
      })
      .where(inArray(agentWakeupRequests.id, wakeupIds));

    return wakeupIds.length;
  }

  async function cancelInvocationsForAgentsInternal(
    agentIds: string[],
    reason: string,
  ) {
    const uniqueAgentIds = [...new Set(agentIds)].filter(
      (agentId) => agentId.length > 0,
    );
    let runsCancelled = 0;
    for (const agentId of uniqueAgentIds) {
      runsCancelled += await cancelActiveForAgentInternal(agentId, reason);
    }
    const wakeupsCancelled = await cancelPendingWakeupsForAgentsInternal(
      uniqueAgentIds,
      reason,
    );
    return {
      agentIds: uniqueAgentIds,
      runsCancelled,
      wakeupsCancelled,
    };
  }

  async function cancelBudgetScopeWork(scope: BudgetEnforcementScope) {
    const runIds = scope.scopeType === "project"
      ? await listProjectScopedRunIds(scope.companyId, scope.scopeId, scope.createdBefore)
      : await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, scope.companyId),
        scope.scopeType === "agent" ? eq(heartbeatRuns.agentId, scope.scopeId) : undefined,
        scope.createdBefore ? lt(heartbeatRuns.createdAt, scope.createdBefore) : undefined,
        inArray(heartbeatRuns.status, [...CANCELLABLE_HEARTBEAT_RUN_STATUSES]),
      )).then((rows) => rows.map((row) => row.id));
    for (const runId of runIds) await cancelRunInternal(runId, "Cancelled due to budget pause", { budgetEnforcement: scope });
    await cancelPendingWakeupsForBudgetScope(scope);
  }

  return {
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

    tickTimers: async (now = new Date()) => {
      if ((await getSchedulingSuppression()).suppressed) {
        return {
          checked: 0,
          enqueued: 0,
          skipped: 0,
        };
      }
      const cutoff = await getWorktreeExecutionCutoff();

      const allAgents = await db
        .select({ ...getTableColumns(agents) })
        .from(agents)
        .innerJoin(companies, eq(companies.id, agents.companyId))
        .where(eq(companies.status, "active"));
      const agentsByCompany = groupAgentOrgRowsByCompany(
        allAgents.map(toAgentOrgRow),
      );
      let checked = 0;
      let enqueued = 0;
      let skipped = 0;

      for (const agent of allAgents) {
        const invokability = evaluateAgentInvokability(
          toAgentOrgRow(agent),
          agentsByCompany.get(agent.companyId) ?? [],
        );
        if (!invokability.invokable) continue;
        const policy = parseHeartbeatPolicy(agent);
        if (!policy.enabled || policy.intervalSec <= 0) continue;

        if (cutoff) {
          const eligibleIssue = await db
            .select({ id: issues.id })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, agent.companyId),
                eq(issues.assigneeAgentId, agent.id),
                inArray(issues.status, ["todo", "in_progress"]),
                gte(issues.createdAt, cutoff),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!eligibleIssue) continue;
        }

        checked += 1;
        const baseline = new Date(
          agent.lastHeartbeatAt ?? agent.createdAt,
        ).getTime();
        const elapsedMs = now.getTime() - baseline;
        if (elapsedMs < policy.intervalSec * 1000) continue;
        const timerClaim = await claimDueTimerHeartbeat(
          agent,
          now,
          policy.intervalSec,
        );
        if (!timerClaim) continue;

        const run = await enqueueWakeup(agent.id, {
          source: "timer",
          triggerDetail: "system",
          reason: "heartbeat_timer",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          contextSnapshot: {
            source: "scheduler",
            reason: "interval_elapsed",
            now: now.toISOString(),
            timerClaimWasFirstHeartbeat: timerClaim.wasFirstHeartbeat,
          },
        });
        if (run) enqueued += 1;
        else skipped += 1;
      }

      const issueMonitors = await tickDueIssueMonitors(now);

      return {
        checked: checked + issueMonitors.checked,
        enqueued: enqueued + issueMonitors.triggered,
        skipped: skipped + issueMonitors.skipped,
      };
    },

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
