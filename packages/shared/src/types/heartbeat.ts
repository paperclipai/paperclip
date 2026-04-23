import type {
  AgentRole,
  AgentStatus,
  HeartbeatInvocationSource,
  HeartbeatRunStatus,
  RunLivenessState,
  WakeupTriggerDetail,
  WakeupRequestStatus,
} from "../constants.js";

export interface HeartbeatRun {
  id: string;
  companyId: string;
  agentId: string;
  invocationSource: HeartbeatInvocationSource;
  triggerDetail: WakeupTriggerDetail | null;
  status: HeartbeatRunStatus;
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
