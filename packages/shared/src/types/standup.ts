import type {
  StandupActionStatus,
  StandupDeliveryStatus,
  StandupEscalationStatus,
  StandupOutboxJobStatus,
  StandupOutboxJobType,
  StandupPolicyStatus,
  StandupResponseStatus,
  StandupSessionStatus,
} from "../constants.js";

export interface StandupPolicy {
  id: string;
  companyId: string;
  policyKey: string;
  standupType: string;
  title: string;
  status: StandupPolicyStatus;
  version: number;
  timezone: string;
  scheduleCron: string;
  recoveryByLocalTime: string;
  responseDueLocalTime: string;
  escalationDueLocalTime: string;
  participantAgentIds: string[];
  responseSchema: Record<string, unknown>;
  genericAnswerDenylist: string[];
  nonGreenTriggerRule: Record<string, unknown>;
  actionRouting: Record<string, unknown>;
  disableSettings: Record<string, unknown>;
  linkedRoutineId: string | null;
  serviceRunId: string | null;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StandupSession {
  id: string;
  companyId: string;
  policyId: string;
  routineId: string | null;
  triggerId: string | null;
  routineRunId: string | null;
  serviceRunId: string | null;
  standupIssueId: string | null;
  localDate: string;
  standupType: string;
  policyVersion: number;
  timezone: string;
  status: StandupSessionStatus;
  triggerSource: string;
  idempotencyKey: string;
  triggerConditionSnapshot: Record<string, unknown>;
  assessmentSnapshot: Record<string, unknown>;
  manualTriggerReceipt: Record<string, unknown> | null;
  partialIssueIds: string[];
  responseDueAt: Date;
  escalationDueAt: Date;
  actionDueAt: Date | null;
  firedAt: Date | null;
  completedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StandupParticipant {
  id: string;
  companyId: string;
  sessionId: string;
  agentId: string;
  roleKey: string;
  directiveIssueId: string | null;
  responseStatus: StandupResponseStatus;
  deliveryStatus: StandupDeliveryStatus;
  responseDueAt: Date;
  escalationDueAt: Date;
  respondedAt: Date | null;
  escalatedAt: Date | null;
  escalationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StandupResponse {
  id: string;
  companyId: string;
  sessionId: string;
  participantId: string;
  actorAgentId: string;
  actorRunId: string | null;
  responseJson: Record<string, unknown>;
  valid: boolean;
  rejectedReason: string | null;
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface StandupAction {
  id: string;
  companyId: string;
  sessionId: string;
  ownerAgentId: string;
  issueId: string | null;
  linkedCommentId: string | null;
  serviceRunId: string | null;
  canonicalKey: string;
  sourceBlockerKey: string;
  dueAt: Date;
  proofTarget: string;
  timingState: string;
  status: StandupActionStatus;
  actionJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface StandupEscalation {
  id: string;
  companyId: string;
  sessionId: string;
  participantId: string;
  agentId: string;
  actingOwnerAgentId: string;
  escalationIssueId: string | null;
  serviceRunId: string | null;
  canonicalKey: string;
  reason: string;
  deadlineAt: Date;
  closureCondition: string;
  deliveryProofId: string | null;
  status: StandupEscalationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface StandupOutboxJob {
  id: string;
  companyId: string;
  sessionId: string;
  participantId: string | null;
  actionId: string | null;
  escalationId: string | null;
  serviceRunId: string | null;
  jobType: StandupOutboxJobType;
  priority: number;
  targetKind: string;
  targetId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: StandupOutboxJobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastAttemptAt: Date | null;
  deliveredAt: Date | null;
  deadLetteredAt: Date | null;
  lastError: string | null;
  replayOfJobId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StandupDeadLetter {
  id: string;
  companyId: string;
  sessionId: string;
  outboxJobId: string;
  reason: string;
  lastError: string | null;
  payloadSnapshot: Record<string, unknown>;
  replayReceipt: Record<string, unknown> | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
