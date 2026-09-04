import type {
  AgentRole,
  AgentStatus,
  HeartbeatInvocationSource,
  HeartbeatRunStatus,
  RunLivenessState,
  WakeupTriggerDetail,
  WakeupRequestStatus,
} from "../constants.js";

export interface ProviderTraceDebugRequest {
  providerTrace: "raw";
}

export type ProviderTraceDirection =
  "client_to_provider" | "provider_to_client" | "provider_stderr";
export type ProviderTraceDisposition =
  "mapped" | "generic" | "ignored" | "rejected" | "operator_only";

export type ProviderTraceFieldMappingAction =
  | "copied"
  | "renamed"
  | "normalized"
  | "derived"
  | "dropped"
  | "redacted";

export interface ProviderTraceFieldMapping {
  inputPath?: string;
  outputPath?: string;
  action: ProviderTraceFieldMappingAction;
  reason?: string;
}

export interface ProviderTraceFrame {
  kind?: "frame";
  schema: "paperclip.provider_trace_frame.v1";
  debugChannel: string;
  debugSequence: number;
  frameId: number;
  timestamp: string;
  direction: ProviderTraceDirection;
  transport: string;
  provider: string;
  byteLength: number;
  digest: `sha256:${string}`;
  rawBase64: string;
}

export interface ProviderTraceInterpretation {
  kind?: "interpretation";
  schema: "paperclip.provider_trace_interpretation.v1";
  debugChannel: string;
  debugSequence: number;
  frameId: number;
  stage: string;
  ruleId: string;
  disposition: ProviderTraceDisposition;
  emittedEventIds: string[];
  droppedFields: string[];
  fieldMappings?: ProviderTraceFieldMapping[];
  reason: string;
}

export type ProviderTraceStatus =
  "capturing" | "complete" | "incomplete" | "truncated" | "deleted" | "expired";

export interface ProviderTraceMetadata {
  schema: "paperclip.provider_trace_metadata.v1";
  id: string;
  runId: string;
  companyId: string;
  status: ProviderTraceStatus;
  provider: string;
  frameCount: number;
  byteCount: number;
  digest: `sha256:${string}` | null;
  reason: string | null;
  requestedBy: string;
  createdAt: string | Date;
  expiresAt: string | Date;
  deletedAt: string | Date | null;
}

export type RunPresentationSource =
  | "existing_issue_comment"
  | "final_agent_message"
  | "semantic_result_summary"
  | "adapter_final_response"
  | "none";

export interface RunPresentationDecision {
  schema: "paperclip.run_presentation_decision.v1";
  resolverVersion: string;
  chosenSource: RunPresentationSource;
  sourceEventId: string | null;
  commentAction: "reuse" | "create" | "none";
  commentId: string | null;
  activityDisposition: "collapse";
  reasonCodes: string[];
}

export type GitWorktreeBranchAncestryVerdict =
  "ancestor" | "diverged" | "unknown";

export type GitWorktreeInProgressOperation =
  "rebase" | "merge" | "cherry_pick" | "revert" | "bisect";

export interface GitWorktreeBranchIncoherenceEvidence {
  reason: "git_worktree_branch_incoherence";
  fingerprint: string;
  sourceIssueId: string | null;
  sourceIdentifier: string | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  repoRoot: string;
  expectedBranch: string;
  actualBranch: string | null;
  cleanliness: "clean" | "dirty" | "unknown";
  /**
   * Interrupted git operation (rebase/merge/cherry-pick/revert/bisect) whose
   * state directory is still present in the worktree. Optional so previously
   * persisted evidence payloads stay valid.
   */
  inProgressOperation?: GitWorktreeInProgressOperation | null;
  statusEntryCount: number | null;
  dirtyPathSample: string[];
  contention: {
    claimedByWorkspaceId: string;
    claimedByIssueId: string | null;
    claimedByIssueIdentifier: string | null;
    activeRun: {
      id: string;
      status: "queued" | "running";
      issueId: string | null;
      issueIdentifier: string | null;
    } | null;
  } | null;
  provenance: {
    expectedBranchRef: string;
    actualBranchRef: string | null;
    registeredBranchRef: string | null;
    registeredPathFound: boolean;
    registeredBranchMatchesHead: boolean;
    expectedBranchExists: boolean;
    actualBranchExists: boolean | null;
    expectedHeadSha: string | null;
    actualHeadSha: string | null;
    sameHead: boolean;
    ancestryVerdict: GitWorktreeBranchAncestryVerdict;
    plainLanguageReason: string;
  };
  safeRepair: {
    eligible: boolean;
    attempted: boolean;
    succeeded: boolean;
    reason: string;
  };
}

export interface HeartbeatRun {
  id: string;
  companyId: string;
  agentId: string;
  invocationSource: HeartbeatInvocationSource;
  triggerDetail: WakeupTriggerDetail | null;
  status: HeartbeatRunStatus;
  responsibleUserId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  wakeupRequestId: string | null;
  exitCode: number | null;
  signal: string | null;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  sessionIdBefore: string | null;
  sessionIdAfter: string | null;
  logStore: string | null;
  logRef: string | null;
  logBytes: number | null;
  logSha256: string | null;
  logCompressed: boolean;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  errorCode: string | null;
  externalRunId: string | null;
  processPid: number | null;
  processGroupId?: number | null;
  processStartedAt: Date | null;
  lastOutputAt: Date | null;
  lastOutputSeq: number;
  lastOutputStream: "stdout" | "stderr" | null;
  lastOutputBytes: number | null;
  retryOfRunId: string | null;
  processLossRetryCount: number;
  scheduledRetryAt?: Date | null;
  scheduledRetryAttempt?: number;
  scheduledRetryReason?: string | null;
  retryExhaustedReason?: string | null;
  livenessState: RunLivenessState | null;
  livenessReason: string | null;
  continuationAttempt: number;
  lastUsefulActionAt: Date | null;
  nextAction: string | null;
  contextSnapshot: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  outputSilence?: HeartbeatRunOutputSilence;
  /**
   * Ephemeral, process-local current status message for an active run. Resolved
   * from the in-memory runtime status store (never persisted to the database)
   * and only populated for active/live run reads. Disappears on TTL expiry,
   * terminal run status, or server restart.
   */
  currentStatusMessage?: string | null;
  currentStatusUpdatedAt?: Date | string | null;
  currentToolName?: string | null;
  lastAssistantSnippet?: string | null;
  lastEventAt?: Date | string | null;
}

/**
 * Typed phase labels emitted by the sandbox-managed runtime as it progresses
 * through workspace preparation, adapter startup, restore/export, and
 * finalization. Used by the ephemeral runtime status plumbing; not persisted.
 */
export type HeartbeatRunStatusPhase =
  | "git_sync"
  | "config_sync"
  | "adapter_startup"
  | "restore"
  | "export"
  | "finalize"
  | "run_activity";

export type HeartbeatRunOutputSilenceLevel =
  "not_applicable" | "ok" | "suspicious" | "critical" | "snoozed";

export interface HeartbeatRunOutputSilence {
  lastOutputAt: Date | string | null;
  lastOutputSeq: number;
  lastOutputStream: "stdout" | "stderr" | null;
  silenceStartedAt: Date | string | null;
  silenceAgeMs: number | null;
  level: HeartbeatRunOutputSilenceLevel;
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
  snoozedUntil: Date | string | null;
  evaluationIssueId: string | null;
  evaluationIssueIdentifier: string | null;
  evaluationIssueAssigneeAgentId: string | null;
}

export interface AgentWakeupSkipped {
  status: "skipped";
  reason: string;
  message: string | null;
  issueId: string | null;
  executionRunId: string | null;
  executionAgentId: string | null;
  executionAgentName: string | null;
}

export type AgentWakeupResponse = HeartbeatRun | AgentWakeupSkipped;

export interface HeartbeatRunEvent {
  id: number;
  companyId: string;
  runId: string;
  agentId: string;
  seq: number;
  eventType: string;
  stream: "system" | "stdout" | "stderr" | null;
  level: "info" | "warn" | "error" | null;
  color: string | null;
  message: string | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AgentRuntimeState {
  agentId: string;
  companyId: string;
  adapterType: string;
  sessionId: string | null;
  sessionDisplayId?: string | null;
  sessionParamsJson?: Record<string, unknown> | null;
  stateJson: Record<string, unknown>;
  lastRunId: string | null;
  lastRunStatus: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalCostCents: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentTaskSession {
  id: string;
  companyId: string;
  agentId: string;
  adapterType: string;
  taskKey: string;
  sessionParamsJson: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  lastRunId: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentWakeupRequest {
  id: string;
  companyId: string;
  agentId: string;
  source: HeartbeatInvocationSource;
  triggerDetail: WakeupTriggerDetail | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  status: WakeupRequestStatus;
  coalescedCount: number;
  requestedByActorType: "user" | "agent" | "system" | null;
  requestedByActorId: string | null;
  idempotencyKey: string | null;
  runId: string | null;
  requestedAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InstanceSchedulerHeartbeatAgent {
  id: string;
  companyId: string;
  companyName: string;
  companyIssuePrefix: string;
  agentName: string;
  agentUrlKey: string;
  role: AgentRole;
  title: string | null;
  status: AgentStatus;
  adapterType: string;
  intervalSec: number;
  heartbeatEnabled: boolean;
  schedulerActive: boolean;
  lastHeartbeatAt: Date | null;
}
